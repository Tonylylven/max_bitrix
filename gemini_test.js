const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG = {
    MAX_API_URL: process.env.MAX_API_URL || 'https://platform-api.max.ru',
    MAX_BOT_TOKEN: process.env.MAX_BOT_TOKEN
};

let lastMarker = null;

async function pollUpdates() {
    try {
        let url = `${CONFIG.MAX_API_URL}/updates?limit=100&timeout=30`;
        if (lastMarker) url += `&marker=${lastMarker}`;

        console.log('🔄 Ожидание сообщения от тебя...');
        const response = await axios.get(url, {
            headers: { 'Authorization': CONFIG.MAX_BOT_TOKEN },
            timeout: 35000 
        });

        if (response.data && response.data.updates && response.data.updates.length > 0) {
            for (const update of response.data.updates) {
                if (update.update_type === 'message_created' && update.message) {
                    const sender = update.message.sender;
                    
                    if (sender && !sender.is_bot) {
                        console.log(`\n================ ПОЙМАЛИ ОБНОВЛЕНИЕ ================`);
                        console.log(`Текст от тебя: "${update.message.body?.text || update.message.body?.plain_text}"`);
                        
                        // ВЫВОДИМ ПОЛНЫЙ JSON ПОЛУЧАТЕЛЯ ИЗ СЕРВЕРА ДЛЯ АНАЛИЗА
                        console.log(`Сырой объект recipient от сервера:`, JSON.stringify(update.message.recipient, null, 2));
                        console.log(`Сырой объект sender от сервера:`, JSON.stringify(update.message.sender, null, 2));

                        // ⚡️ ТЕСТ: Клонируем структуру recipient один в один
                        console.log('\n🚀 Пробуем зеркальный gRPC-ответ...');
                        try {
                            const payload = {
                                // Берем объект recipient ОДИН В ОДИН как его прислал сервер
                                recipient: update.message.recipient, 
                                body: {
                                    plain_text: "Зеркальный ответ сработал!"
                                }
                            };
                            
                            const res = await axios.post(`${CONFIG.MAX_API_URL}/messages`, payload, {
                                headers: { 'Authorization': CONFIG.MAX_BOT_TOKEN, 'Content-Type': 'application/json' }
                            });
                            console.log('🎉 ОГО! Зеркальный метод сработал!', res.data);
                        } catch (err) {
                            console.log('❌ Зеркальный метод тоже выдал Unknown recipient.');
                            if (err.response) {
                                console.log('Ответ бэкенда при клонировании:', err.response.data);
                            }
                        }
                    }
                }
            }
        }

        if (response.data && response.data.marker) {
            lastMarker = response.data.marker;
        }
        setImmediate(pollUpdates);
    } catch (error) {
        console.error('Ошибка Long Polling:', error.message);
        setTimeout(pollUpdates, 5000);
    }
}

app.listen(PORT, () => {
    console.log(`Сканер запущен. Напиши боту что-нибудь...`);
    pollUpdates();
});