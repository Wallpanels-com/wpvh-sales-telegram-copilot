import type { AppConfig } from '../config.js';

export function canDeliverToTelegram(config: AppConfig, telegramUserId: string): boolean {
  if (config.TELEGRAM_DELIVERY_MODE === 'disabled') return false;
  if (config.TELEGRAM_DELIVERY_MODE === 'all') return true;
  return config.telegramAllowedUserIds.has(telegramUserId);
}
