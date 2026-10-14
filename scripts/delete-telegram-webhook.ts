import { loadConfig } from '../src/config.js';
import { TelegramClient } from '../src/services/telegram.js';
const config = loadConfig();
const telegram = new TelegramClient(config);
await telegram.deleteWebhook();
console.log('Telegram webhook removed');
