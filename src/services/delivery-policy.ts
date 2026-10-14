import type { AppConfig } from '../config.js';
import { escapeHtml } from '../utils/html.js';

export function isShadowTestActive(config: AppConfig, now = Date.now()): boolean {
  if (!config.SHADOW_TEST_ENABLED) return false;
  if (!config.SHADOW_TEST_UNTIL) return true;
  return Date.parse(config.SHADOW_TEST_UNTIL) > now;
}

export function shouldProcessAssignedSales(config: AppConfig, assignedGhlUserId?: string): boolean {
  if (!config.SHADOW_TEST_ENABLED) return true;
  return isShadowTestActive(config) && Boolean(assignedGhlUserId && config.shadowTestSalesGhlIds.has(assignedGhlUserId));
}

export function prependShadowTestPrefix(config: AppConfig, text: string, assignedSalesName?: string): string {
  if (!isShadowTestActive(config)) return text;
  const label = assignedSalesName?.trim() || 'Assigned Sales';
  return `[SHADOW TEST — ${escapeHtml(label)}]\n${text}`;
}

export function canDeliverToTelegram(config: AppConfig, telegramUserId: string): boolean {
  if (config.SHADOW_TEST_ENABLED) {
    return isShadowTestActive(config) && telegramUserId === config.SHADOW_TEST_RECIPIENT_TELEGRAM_ID;
  }
  if (config.TELEGRAM_DELIVERY_MODE === 'disabled') return false;
  if (config.TELEGRAM_DELIVERY_MODE === 'all') return true;
  return config.telegramAllowedUserIds.has(telegramUserId);
}
