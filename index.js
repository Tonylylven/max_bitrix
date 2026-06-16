const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== КОНФИГУРАЦИЯ =====
const CONFIG = {
    MAX_API_URL: process.env.MAX_API_URL || 'https://platform-api.max.ru',
    MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN,
    BITRIX_WEBHOOK_URL: process.env.BITRIX_WEBHOOK_URL,
    BITRIX_RESPONSIBLE_ID: parseInt(process.env.BITRIX_RESPONSIBLE_ID, 10),
    BITRIX_ACCOMPLICES: process.env.BITRIX_ACCOMPLICES
        ? process.env.BITRIX_ACCOMPLICES.split(',').map(id => parseInt(id.trim(), 10))
        : []
};

// Проверка обязательных переменных
if (!CONFIG.MAX_BOT_TOKEN || !CONFIG.BITRIX_WEBHOOK_URL || !CONFIG.BITRIX_RESPONSIBLE_ID) {
    console.error('❌ Ошибка: не все переменные окружения заданы. Проверьте .env файл.');
    process.exit(1);
}

// Хранилище сессий пользователей (в памяти)
const userSessions = {};

app.use(express.json());

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
function isValidTitle(title) {
    return title && title.trim().length >= 3;
}

function isValidFullname(fullname) {
    return fullname && fullname.trim().length >= 3;
}

function isValidCabinet(cabinet) {
    return cabinet && cabinet.trim().length >= 1;
}

function resetSession(chatId) {
    delete userSessions[chatId];
}

/**
 * Отправка сообщения в Max
 */
async function sendMaxMessage(chatId, text) {
     console.log(`🔵 Вызвана sendMaxMessage для ${chatId}, текст: ${text.substring(0, 50)}`);
    try {
        const response = await axios.post(`${CONFIG.MAX_API_URL}/messages`, {
            user_id: chatId, // <- ИСПРАВЛЕНО: chat_id заменён на user_id
            text: text,
            format: "markdown"
        }, {
            headers: {
                'Authorization': CONFIG.MAX_BOT_TOKEN,
                'Content-Type': 'application/json'
            }
        });
        console.log(`📤 Ответ успешно отправлен пользователю ${chatId}.`, response.data);
    } catch (error) {
        // Выводим максимально подробную информацию об ошибке
        if (error.response) {
            console.error('❌ Ошибка отправки сообщения в Max:', error.response.status, error.response.statusText);
            console.error('   Тело ответа API:', JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error('❌ Ошибка отправки: сервер Max не отвечает.', error.request);
        } else {
            console.error('❌ Ошибка отправки:', error.message);
        }
    }
}

/**
 * Создание задачи в Битрикс24
 */
async function createBitrixTask(title, description) {
    try {
        const response = await axios.post(`${CONFIG.BITRIX_WEBHOOK_URL}tasks.task.add`, {
            fields: {
                TITLE: title,
                DESCRIPTION: description || 'Нет описания',
                RESPONSIBLE_ID: CONFIG.BITRIX_RESPONSIBLE_ID,
                ACCOMPLICES: CONFIG.BITRIX_ACCOMPLICES
            }
        });
        console.log('✅ Задача создана в Битрикс24:', response.data);
        return { success: true, data: response.data.result };
    } catch (error) {
        console.error('❌ Ошибка Битрикс24:', error.response?.data || error.message);
        return { success: false, error: error.response?.data || error.message };
    }
}

// ===== ОСНОВНАЯ ЛОГИКА БОТА (обработка одного сообщения) =====
async function processMessage(chatId, messageText) {
    const trimmedText = messageText.trim();
    console.log(`💬 Сообщение от ${chatId}: ${trimmedText}`);

    // Команда отмены
    if (trimmedText.toLowerCase() === 'отмена') {
        resetSession(chatId);
        await sendMaxMessage(chatId, '❌ Создание задачи отменено. Если захотите создать новую, просто напишите любое сообщение.');
        return;
    }

    let session = userSessions[chatId];
    // Новая сессия — начинаем с заголовка
    if (!session) {
        session = { step: 'awaiting_title' };
        userSessions[chatId] = session;
        await sendMaxMessage(chatId,
            '👋 Привет! Я помогу создать задачу в Битрикс24.\n\n' +
            '**Шаг 1:** Введите **заголовок задачи** (минимум 3 символа).\n' +
            'Если передумаете, напишите "отмена".'
        );
        return;
    }

    // --- Шаг 1: заголовок ---
    if (session.step === 'awaiting_title') {
        if (!isValidTitle(trimmedText)) {
            await sendMaxMessage(chatId,
                '❌ Заголовок должен содержать минимум 3 символа. Попробуйте ещё раз или "отмена".'
            );
            return;
        }
        session.title = trimmedText;
        session.step = 'awaiting_description';
        await sendMaxMessage(chatId,
            '✅ Заголовок принят.\n\n**Шаг 2:** Введите **описание задачи** (что случилось, детали).'
        );
        return;
    }

    // --- Шаг 2: описание ---
    if (session.step === 'awaiting_description') {
        if (!trimmedText) {
            await sendMaxMessage(chatId, '❌ Описание не может быть пустым. Введите описание или "отмена".');
            return;
        }
        session.description = trimmedText;
        session.step = 'awaiting_fullname';
        await sendMaxMessage(chatId,
            '✅ Описание принято.\n\n**Шаг 3:** Введите ваше **ФИО** (минимум 3 символа).'
        );
        return;
    }

    // --- Шаг 3: ФИО ---
    if (session.step === 'awaiting_fullname') {
        if (!isValidFullname(trimmedText)) {
            await sendMaxMessage(chatId,
                '❌ ФИО должно содержать минимум 3 символа. Введите корректное ФИО или "отмена".'
            );
            return;
        }
        session.fullname = trimmedText;
        session.step = 'awaiting_cabinet';
        await sendMaxMessage(chatId,
            '✅ ФИО принято.\n\n**Шаг 4:** Введите **номер кабинета** (например, 101 или 5-2).'
        );
        return;
    }

    // --- Шаг 4: кабинет ---
    if (session.step === 'awaiting_cabinet') {
        if (!isValidCabinet(trimmedText)) {
            await sendMaxMessage(chatId, '❌ Кабинет не может быть пустым. Введите номер кабинета или "отмена".');
            return;
        }
        session.cabinet = trimmedText;

        const fullTitle = `${session.fullname} (каб. ${session.cabinet}): ${session.title}`;
        const description = session.description;

        const result = await createBitrixTask(fullTitle, description);

        if (result.success) {
            await sendMaxMessage(chatId,
                `✅ Задача успешно создана!\n\n` +
                `**Заголовок:** ${fullTitle}\n` +
                `**Описание:** ${description}\n\n` +
                `Спасибо! Задача передана в Битрикс24.`
            );
        } else {
            await sendMaxMessage(chatId,
                `❌ Ошибка при создании задачи:\n${JSON.stringify(result.error)}`
            );
        }

        resetSession(chatId);
        return;
    }

    // Если сессия в неизвестном состоянии — сброс
    resetSession(chatId);
    await sendMaxMessage(chatId, '⚠️ Произошла ошибка. Начнём заново. Напишите любое сообщение.');
}

// ===== LONG POLLING (получение сообщений) =====
let lastMarker = null;

async function pollUpdates() {
    try {
        let url = `${CONFIG.MAX_API_URL}/updates?limit=100&timeout=30`;
        if (lastMarker) {
            url += `&marker=${lastMarker}`;
        }

        console.log('🔄 Запрос обновлений (Long Polling)...');
        const response = await axios.get(url, {
            headers: { 'Authorization': CONFIG.MAX_BOT_TOKEN },
            timeout: 35000 
        });

        if (response.data && response.data.updates && response.data.updates.length > 0) {
            console.log(`📨 Получено обновлений: ${response.data.updates.length}`);
            
            for (const update of response.data.updates) {
                // ВАЖНО: Выводим в консоль сырую структуру обновления, чтобы увидеть ключи
                console.log('📝 СЫРЫЕ ДАННЫЕ ОБНОВЛЕНИЯ:', JSON.stringify(update, null, 2));

                // Облегченная проверка (проверяем наличие текста, игнорируя тип события)
                if (update.message && update.message.text) {
                    const chatId = update.message.chat?.id || update.message.user_id || update.message.from?.id;
                    const text = update.message.text;
                    await processMessage(chatId, text);
                } else if (update.text && update.chat_id) { 
                    // Альтернативная плоская структура, которая бывает в некоторых версиях API VK/Max
                    await processMessage(update.chat_id, update.text);
                }
            }
        }

        if (response.data && response.data.marker) {
            lastMarker = response.data.marker;
        }

        setImmediate(pollUpdates);
    } catch (error) {
        console.error('❌ Ошибка в цикле Long Polling:', error.response?.data || error.message);
        setTimeout(pollUpdates, 5000);
    }
}

// ===== ЗАПУСК СЕРВЕРА =====
app.listen(PORT, () => {
    console.log(`🚀 Бот для Max запущен на порту ${PORT}`);
    console.log(`📡 Режим: Long Polling (вебхук не используется)`);
    pollUpdates();
});