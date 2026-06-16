import { Bot } from '@maxhub/max-bot-api';
import axios from 'axios';
import 'dotenv/config';

const CONFIG = {
    MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN,
    BITRIX_WEBHOOK_URL: process.env.BITRIX_WEBHOOK_URL,
    BITRIX_RESPONSIBLE_ID: parseInt(process.env.BITRIX_RESPONSIBLE_ID, 10),
    BITRIX_ACCOMPLICES: process.env.BITRIX_ACCOMPLICES
        ? process.env.BITRIX_ACCOMPLICES.split(',').map(id => parseInt(id.trim(), 10))
        : []
};

if (!CONFIG.MAX_BOT_TOKEN || !CONFIG.BITRIX_WEBHOOK_URL || !CONFIG.BITRIX_RESPONSIBLE_ID) {
    console.error('❌ Ошибка: проверь .env');
    process.exit(1);
}

const bot = new Bot(CONFIG.MAX_BOT_TOKEN);
const userSessions = {};

// ===== ВАЛИДАЦИЯ =====
const isValidTitle = (t) => t && t.trim().length >= 3;
const isValidFullname = (f) => f && f.trim().length >= 3;
const isValidCabinet = (c) => c && c.trim().length >= 1;
const resetSession = (userId) => { delete userSessions[userId]; console.log(`🗑️ Сессия ${userId} сброшена`); };

// ===== ОТПРАВКА =====
async function reply(ctx, text) {
    try {
        await ctx.reply(text);
        console.log(`📤 Ответ: ${text.substring(0, 80)}`);
    } catch (err) {
        console.error('❌ Ошибка отправки:', err.message);
    }
}

// ===== БИТРИКС =====
async function createBitrixTask(title, description) {
    try {
        await axios.post(`${CONFIG.BITRIX_WEBHOOK_URL}tasks.task.add`, {
            fields: {
                TITLE: title,
                DESCRIPTION: description || 'Нет описания',
                RESPONSIBLE_ID: CONFIG.BITRIX_RESPONSIBLE_ID,
                ACCOMPLICES: CONFIG.BITRIX_ACCOMPLICES
            }
        }, { timeout: 15000 });
        console.log('✅ Задача создана');
        return { success: true };
    } catch (error) {
        console.error('❌ Битрикс ошибка:', error.message);
        return { success: false, error: error.message };
    }
}

// ===== КОМАНДЫ =====
bot.api.setMyCommands([
    { name: 'start', description: 'Новая задача' },
    { name: 'cancel', description: 'Отмена' }
]);

bot.command('start', async (ctx) => {
    const userId = ctx.message.sender.user_id;
    resetSession(userId);
    userSessions[userId] = { step: 'awaiting_title' };
    await reply(ctx, '👋 Привет! Создадим задачу.\n**Шаг 1:** Введите заголовок (мин. 3 символа).\nОтмена: "отмена" или /cancel');
});

bot.command('cancel', async (ctx) => {
    const userId = ctx.message.sender.user_id;
    resetSession(userId);
    await reply(ctx, '❌ Отменено. /start для новой задачи.');
});

// ===== ОБРАБОТЧИК message_created (исправлен доступ к тексту) =====
bot.on('message_created', async (ctx) => {
    try {
        // ★★★ КОРРЕКТНЫЙ ПУТЬ К ТЕКСТУ ★★★
        const text = ctx.message.body?.text?.trim() || '';
        const userId = ctx.message.sender?.user_id;

        if (!userId) {
            console.error('❌ Нет userId в сообщении');
            return;
        }

        console.log(`📥 Получено от ${userId}: "${text}"`);

        // Игнорируем команды, начинающиеся с /
        if (text.startsWith('/')) {
            console.log(`⏭️ Игнорируем команду ${text}`);
            return;
        }

        // Отмена через слово
        if (text.toLowerCase() === 'отмена') {
            resetSession(userId);
            await reply(ctx, '❌ Отменено. Напишите /start для новой задачи.');
            return;
        }

        let session = userSessions[userId];

        // Если сессии нет — автостарт
        if (!session) {
            userSessions[userId] = { step: 'awaiting_title' };
            await reply(ctx, 'Начинаем.\n**Шаг 1:** Введите заголовок (мин. 3 символа).');
            return;
        }

        // --- ШАГ 1: ЗАГОЛОВОК ---
        if (session.step === 'awaiting_title') {
            if (!isValidTitle(text)) {
                await reply(ctx, '❌ Заголовок должен быть минимум 3 символа. Попробуйте ещё.');
                return;
            }
            session.title = text;
            session.step = 'awaiting_description';
            await reply(ctx, '✅ Заголовок принят.\n\n**Шаг 2:** Введите описание задачи.');
            return;
        }

        // --- ШАГ 2: ОПИСАНИЕ ---
        if (session.step === 'awaiting_description') {
            if (!text) {
                await reply(ctx, '❌ Описание не может быть пустым.');
                return;
            }
            session.description = text;
            session.step = 'awaiting_fullname';
            await reply(ctx, '✅ Описание принято.\n\n**Шаг 3:** Введите ваше ФИО (мин. 3 символа).');
            return;
        }

        // --- ШАГ 3: ФИО ---
        if (session.step === 'awaiting_fullname') {
            if (!isValidFullname(text)) {
                await reply(ctx, '❌ ФИО должно быть минимум 3 символа. Попробуйте ещё.');
                return;
            }
            session.fullname = text;
            session.step = 'awaiting_cabinet';
            await reply(ctx, '✅ ФИО принято.\n\n**Шаг 4:** Введите номер кабинета (например, 104).');
            return;
        }

        // --- ШАГ 4: КАБИНЕТ И СОЗДАНИЕ ---
        if (session.step === 'awaiting_cabinet') {
            if (!isValidCabinet(text)) {
                await reply(ctx, '❌ Номер кабинета не может быть пустым.');
                return;
            }
            session.cabinet = text;
            const fullTitle = `${session.fullname} (каб. ${session.cabinet}): ${session.title}`;
            await reply(ctx, '⏳ Отправляю в Битрикс24...');
            const result = await createBitrixTask(fullTitle, session.description);
            if (result.success) {
                await reply(ctx, `✅ **Задача создана!**\n${fullTitle}\n\nОтветственный уведомлён.`);
            } else {
                await reply(ctx, `❌ Ошибка Битрикс24: ${result.error}`);
            }
            resetSession(userId);
            return;
        }
    } catch (err) {
        console.error('❌ Критическая ошибка в обработчике:', err);
        // Пытаемся уведомить пользователя об ошибке
        try {
            await ctx.reply('⚠️ Произошла внутренняя ошибка. Начните с /start.');
        } catch (e) {}
        const userId = ctx.message?.sender?.user_id;
        if (userId) resetSession(userId);
    }
});

// ===== ЗАПУСК С ПЕРЕЗАПУСКОМ =====
async function run() {
    while (true) {
        try {
            console.log('🚀 Бот запущен');
            await bot.start();
        } catch (err) {
            console.error('❌ Бот упал:', err.message);
            console.log('🔄 Перезапуск через 5 сек...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}
run();