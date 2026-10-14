import { config as loadDotenv } from 'dotenv';
import { TelegramClient } from '../src/services/telegram.js';

loadDotenv({ path: '.env.local' });
loadDotenv();

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const telegram = new TelegramClient({
  TELEGRAM_BOT_TOKEN: required('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_WEBHOOK_SECRET: required('TELEGRAM_WEBHOOK_SECRET')
});
const url = `${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/webhooks/telegram`;
const me = await telegram.getMe();
console.log(`Bot: @${me.username ?? me.first_name}`);
await telegram.setWebhook(url);
await telegram.setCommands();
const webhook = await telegram.getWebhookInfo();
console.log(`Telegram webhook configured: ${webhook.url}`);
console.log(`Pending updates: ${webhook.pending_update_count ?? 0}`);
