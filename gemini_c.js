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
async function createBitrixTask(baseTitle, description) {
    try {
        // 1. Создаем задачу с базовым заголовком
        const response = await axios.post(`${CONFIG.BITRIX_WEBHOOK_URL}tasks.task.add`, {
            fields: {
                TITLE: baseTitle,
                DESCRIPTION: description || 'Нет описания',
                RESPONSIBLE_ID: CONFIG.BITRIX_RESPONSIBLE_ID,
                ACCOMPLICES: CONFIG.BITRIX_ACCOMPLICES
            }
        }, { timeout: 15000 });
        
        const taskId = response.data?.result?.task?.id; 

        if (!taskId) {
            throw new Error('Не удалось получить ID созданной задачи от Битрикс24');
        }

        console.log(`✅ Задача №${taskId} создана в Битрикс24. Обновляем заголовок...`);

        // 2. Формируем финальный заголовок с ID в начале
        const finalTitle = `№${taskId} - ${baseTitle}`;

        // 3. Обновляем заголовок задачи в Битриксе
        await axios.post(`${CONFIG.BITRIX_WEBHOOK_URL}tasks.task.update`, {
            taskId: taskId,
            fields: {
                TITLE: finalTitle
            }
        }, { timeout: 10000 });

        console.log(`✅ Заголовок задачи №${taskId} успешно изменен в CRM`);
        
        return { success: true, taskId: taskId, finalTitle: finalTitle };
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
            setSession(userId, 'awaiting_lastname', { title: session.title, description: text });
            await reply(ctx, '✅ Описание принято.\n\n**Шаг 3:** Введите вашу **Фамилию**:');
            return;
        }

        // --- ШАГ 3: ФАМИЛИЯ ---
        if (session.step === 'awaiting_lastname') {
            if (!isValidString(text, 2)) {
                await reply(ctx, '❌ Фамилия слишком короткая. Попробуйте ещё раз:');
                return;
            }
            setSession(userId, 'awaiting_firstname', { 
                title: session.title, 
                description: session.description, 
                lastname: text 
            });
            await reply(ctx, '✅ Фамилия принята.\n\n**Шаг 4:** Введите ваше **Имя**:');
            return;
        }

        // --- ШАГ 4: ИМЯ ---
        if (session.step === 'awaiting_firstname') {
            if (!isValidString(text, 2)) {
                await reply(ctx, '❌ Имя слишком короткое. Попробуйте ещё раз:');
                return;
            }
            setSession(userId, 'awaiting_middlename', { 
                title: session.title, 
                description: session.description, 
                lastname: session.lastname,
                firstname: text 
            });
            await reply(ctx, '✅ Имя принято.\n\n**Шаг 5:** Введите ваше **Отчество** (если нет, поставьте прочерк "-"):');
            return;
        }

        // --- ШАГ 5: ОТЧЕСТВО ---
        if (session.step === 'awaiting_middlename') {
            if (!isValidString(text, 1)) {
                await reply(ctx, '❌ Отчество не может быть пустым. Попробуйте ещё раз (или введите "-"):');
                return;
            }
            
            // Если ввели прочерк, игнорируем его при сборке ФИО
            const middlename = text === '-' ? '' : text;

            setSession(userId, 'awaiting_cabinet', { 
                title: session.title, 
                description: session.description, 
                lastname: session.lastname,
                firstname: session.firstname,
                middlename: middlename
            });
            await reply(ctx, '✅ Отчество принято.\n\n**Шаг 6:** Введите номер кабинета (например, 205):');
            return;
        }

        // --- ШАГ 6: КАБИНЕТ И СОЗДАНИЕ ---
        if (session.step === 'awaiting_cabinet') {
            const cabinetNum = parseInt(text, 10);

            // Проверяем, что ввели число и оно входит в разрешенные диапазоны
            const isValidCabinet = 
                (!isNaN(cabinetNum)) && 
                ((cabinetNum >= 201 && cabinetNum <= 212) || (cabinetNum >= 301 && cabinetNum <= 310));

            if (!isValidCabinet) {
                await reply(ctx, '❌ Такого кабинета не существует. Допустимые кабинеты: 201-212 и 301-310. Укажите корректный кабинет:');
                return;
            }

            // Красиво собираем ФИО, убирая лишние пробелы, если отчество отсутствует
            const fullName = `${session.lastname} ${session.firstname} ${session.middlename}`.trim().replace(/\s+/g, ' ');
            const baseTitle = `${fullName} (каб. ${cabinetNum}): ${session.title}`;
            
            await reply(ctx, '⏳ Отправляю в Битрикс24...');
            
            // Запускаем процесс создания и последующего обновления заголовка
            const result = await createBitrixTask(baseTitle, session.description);
            
            if (result.success) {
                await reply(ctx, `✅ **Задача №${result.taskId} успешно создана!**\n\nВы поставлены в очередь на выполнение. Специалист уже уведомлен и скоро займется вашим вопросом.\n\n📌 *${result.finalTitle}*`);
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
        processingUsers.delete(userId); // Освобождаем блокировку пользователя
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

// ===== ЗАЩИТА ОТ КРИТИЧЕСКИХ ПАДЕНИЙ =====
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