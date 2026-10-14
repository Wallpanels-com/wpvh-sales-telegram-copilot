import { loadConfig } from '../src/config.js';
import { TelegramClient } from '../src/services/telegram.js';

const config = loadConfig();
if (!config.PUBLIC_BASE_URL) throw new Error('PUBLIC_BASE_URL is required');
const telegram = new TelegramClient(config);
const url = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/webhooks/telegram`;
const me = await telegram.getMe();
console.log(`Bot: @${me.username ?? me.first_name}`);
await telegram.setWebhook(url);
await telegram.setCommands();
console.log(`Telegram webhook configured: ${url}`);
