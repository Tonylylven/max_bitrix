import { Bot } from '@maxhub/max-bot-api';

// Замените ТОКЕН на тот, который вы получили в разделе Чат-боты → Интеграция → Получить токен
const token = 'f9LHodD0cOI7s_ZOExytDJeYr6_RtAibXVbQcGozC61nqpy3OJwuK-gcgN2ZS2-Tpi1MpbC0XBMM6fnbVrfg';

const bot = new Bot(token);

// Настройка подсказок команд в интерфейсе чата
bot.api.setMyCommands([
    {
        name: 'start',
        description: 'Запустить бота',
    }
]);

// Обработчик команды /start
bot.command('start', (ctx) => {
    return ctx.reply('Привет! Я твой бот в MAX. Отправь мне любое сообщение, и я отвечу тебе!');
});

// Обработчик любых входящих текстовых сообщений (Эхо-режим)
bot.on('message:text', (ctx) => {
    // Получаем текст, который прислал пользователь
    const userText = ctx.message.text;
    
    // Отвечаем пользователю его же текстом
    return ctx.reply(`Вы сказали: "${userText}"`);
});

// Запуск процесса получения обновлений (Long Polling)
bot.start();

console.log('Бот успешно запущен и слушает сообщения...');