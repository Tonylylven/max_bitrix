import { Bot } from '@maxhub/max-bot-api';
import axios from 'axios';
import express from 'express'; // Подключаем express для Render.com
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

// ===== ФЕЙКОВЫЙ ВЕБ-СЕРВЕР ДЛЯ RENDER.COM =====
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('🤖 Бот активен, Keep-Alive запущен и слушает запросы Render!');
});

app.listen(PORT, () => {
    console.log(`🌐 Фейковый веб-сервер успешно занял порт ${PORT} для прохождения Port Scan на Render`);
});

const bot = new Bot(CONFIG.MAX_BOT_TOKEN);
const userSessions = new Map();
const processingUsers = new Set();
const SESSION_TTL = 30 * 60 * 1000; // 30 минут

// ===== УПРАВЛЕНИЕ СЕССИЯМИ =====
const resetSession = (userId) => { 
    if (userSessions.has(userId)) {
        clearTimeout(userSessions.get(userId).timeoutId);
        userSessions.delete(userId);
        console.log(`🗑️ Сессия ${userId} сброшена`);
    }
};

const setSession = (userId, step, data = {}) => {
    resetSession(userId); // Очищаем старый таймаут перед созданием нового

    const timeoutId = setTimeout(() => {
        console.log(`⏳ Сессия ${userId} автоматически удалена по неактивности (TTL)`);
        userSessions.delete(userId);
    }, SESSION_TTL);

    userSessions.set(userId, { step, ...data, timeoutId });
};

// ===== ВАЛИДАЦИЯ =====
const isValidString = (str, minLength = 1) => str && str.trim().length >= minLength;

// ===== ОТПРАВКА =====
async function reply(ctx, text) {
    try {
        await ctx.reply(text);
        console.log(`📤 Ответ: ${text.substring(0, 80).replace(/\n/g, ' ')}...`);
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
        console.log('✅ Задача создана в Битрикс24');
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
    const userId = ctx.message?.sender?.user_id;
    if (!userId) return;

    setSession(userId, 'awaiting_title');
    await reply(ctx, '👋 Привет! Создадим задачу.\n\n**Шаг 1:** Введите заголовок (мин. 3 символа).\nОтмена: "отмена" или /cancel');
});

bot.command('cancel', async (ctx) => {
    const userId = ctx.message?.sender?.user_id;
    if (!userId) return;

    resetSession(userId);
    await reply(ctx, '❌ Отменено. /start для новой задачи.');
});

// ===== ОБРАБОТЧИК message_created =====
bot.on('message_created', async (ctx) => {
    const userId = ctx.message?.sender?.user_id;
    const text = ctx.message?.body?.text?.trim() || '';

    if (!userId) return;

    // Защита от race condition (параллельных кликов)
    if (processingUsers.has(userId)) return;

    if (text.startsWith('/')) return;

    if (text.toLowerCase() === 'отмена') {
        resetSession(userId);
        await reply(ctx, '❌ Отменено. Напишите /start для новой задачи.');
        return;
    }

    try {
        processingUsers.add(userId);
        const session = userSessions.get(userId);

        // Если сессии нет — автостарт
        if (!session) {
            setSession(userId, 'awaiting_title');
            await reply(ctx, 'Начинаем.\n\n**Шаг 1:** Введите заголовок (мин. 3 символа).');
            return;
        }

        console.log(`📥 Получено от ${userId} [Этап: ${session.step}]: "${text}"`);

        // --- ШАГ 1: ЗАГОЛОВОК ---
        if (session.step === 'awaiting_title') {
            if (!isValidString(text, 3)) {
                await reply(ctx, '❌ Заголовок слишком короткий. Должно быть минимум 3 символа. Попробуйте ещё раз:');
                return;
            }
            setSession(userId, 'awaiting_description', { title: text });
            await reply(ctx, '✅ Заголовок принят.\n\n**Шаг 2:** Введите описание задачи.');
            return;
        }

        // --- ШАГ 2: ОПИСАНИЕ ---
        if (session.step === 'awaiting_description') {
            if (!isValidString(text, 1)) {
                await reply(ctx, '❌ Описание не может быть пустым. Пожалуйста, укажите детали:');
                return;
            }
            setSession(userId, 'awaiting_fullname', { title: session.title, description: text });
            await reply(ctx, '✅ Описание принято.\n\n**Шаг 3:** Введите ваше ФИО (мин. 3 символа).');
            return;
        }

        // --- ШАГ 3: ФИО ---
        if (session.step === 'awaiting_fullname') {
            if (!isValidString(text, 3)) {
                await reply(ctx, '❌ ФИО указано некорректно (мин. 3 символа). Попробуйте ещё раз:');
                return;
            }
            setSession(userId, 'awaiting_cabinet', { 
                title: session.title, 
                description: session.description, 
                fullname: text 
            });
            await reply(ctx, '✅ ФИО принято.\n\n**Шаг 4:** Введите номер кабинета (например, 104):');
            return;
        }

        // --- ШАГ 4: КАБИНЕТ И СОЗДАНИЕ ---
        if (session.step === 'awaiting_cabinet') {
            if (!isValidString(text, 1)) {
                await reply(ctx, '❌ Номер кабинета не может быть пустым. Укажите кабинет:');
                return;
            }

            const fullTitle = `${session.fullname} (каб. ${text}): ${session.title}`;
            await reply(ctx, '⏳ Отправляю в Битрикс24...');
            
            const result = await createBitrixTask(fullTitle, session.description);
            if (result.success) {
                await reply(ctx, `✅ **Задача создана!**\n\n📌 *${fullTitle}*\n\nОтветственный уведомлён.`);
            } else {
                await reply(ctx, `❌ Ошибка Битрикс24: ${result.error}`);
            }
            resetSession(userId);
        }
    } catch (err) {
        console.error('❌ Критическая ошибка в обработчике:', err);
        try {
            await ctx.reply('⚠️ Произошла внутренняя ошибка. Начните с /start.');
        } catch (e) {}
        resetSession(userId);
    } finally {
        processingUsers.delete(userId); // Всегда освобождаем блокировку пользователя
    }
});

// ===== БЕЗОПАСНЫЙ ЗАПУСК БОТА =====
let isBotStarted = false;
let keepAliveInterval = null;

async function startBot() {
    if (isBotStarted) return;

    try {
        isBotStarted = true;
        console.log('🚀 Инициализация и запуск бота...');
        
        await bot.start();
        
        console.log('✅ Бот успешно подключен к серверам MaxHub');

        // Heartbeat каждые 5 минут, чтобы соединение не закрывалось сервером MaxHub
        if (!keepAliveInterval) {
            keepAliveInterval = setInterval(async () => {
                try {
                    if (bot.api && typeof bot.api.getMe === 'function') {
                        await bot.api.getMe();
                    } else {
                        await bot.api.setMyCommands([
                            { name: 'start', description: 'Новая задача' },
                            { name: 'cancel', description: 'Отмена' }
                        ]);
                    }
                    console.log('💓 Пинг сервера MaxHub (Keep-Alive)...');
                } catch (e) {
                    console.error('⚠️ Ошибка Keep-Alive пинга:', e.message);
                }
            }, 5 * 60 * 1000);
        }

    } catch (err) {
        isBotStarted = false;
        console.error('❌ Бот упал при старте:', err.message);
        console.log('🔄 Перезапуск инициализации через 15 секунд...');
        setTimeout(startBot, 15000); 
    }
}

// Запускаем бота
startBot();

// ===== ЗАЩИТА ОТ КРИТИЧЕСКИХ ПАДЕНИЙ (АНТИ-КРАШ) =====
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ Критическая ошибка (Unhandled Rejection):', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ Критическая ошибка (Uncaught Exception):', err.message);
    
    if (err.message.includes('fetch failed') || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
        console.log('📡 Соединение разорвано сервером (таймаут 30 мин) или пропала сеть.');
        
        isBotStarted = false; 
        if (keepAliveInterval) {
            clearInterval(keepAliveInterval);
            keepAliveInterval = null;
        }
        
        console.log('🔄 Запуск чистой сессии переподключения через 10 секунд...');
        setTimeout(startBot, 10000);
    } else {
        console.log('🛑 Принудительный выход из-за неизвестной ошибки...');
        process.exit(1);
    }
});