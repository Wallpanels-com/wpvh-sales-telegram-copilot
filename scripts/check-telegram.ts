import { config as loadDotenv } from 'dotenv';
import type { AppConfig } from '../src/config.js';
import { TelegramClient } from '../src/services/telegram.js';

loadDotenv({ path: ['.env.local', '.env'], quiet: true });

if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const telegram = new TelegramClient({
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_WEBHOOK_SECRET: process.env.TELEGRAM_WEBHOOK_SECRET || 'preflight-only-secret'
} as AppConfig);
const me = await telegram.getMe();
console.log(JSON.stringify({ ok: true, id: String(me.id), username: me.username ? `@${me.username}` : null }, null, 2));
