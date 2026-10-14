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
await telegram.deleteWebhook();
console.log('Telegram webhook removed');
