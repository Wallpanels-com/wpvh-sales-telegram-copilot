import type { AppConfig } from '../config.js';
import { escapeHtml } from '../utils/html.js';

export function isShadowTestActive(config: AppConfig, now = Date.now()): boolean {
  if (!config.SHADOW_TEST_ENABLED) return false;
  if (!config.SHADOW_TEST_UNTIL) return true;
  return Date.parse(config.SHADOW_TEST_UNTIL) > now;
}

export function shouldProcessAssignedSales(config: AppConfig, assignedGhlUserId?: string): boolean {
  if (config.SHADOW_TEST_ENABLED) {
    return isShadowTestActive(config) && Boolean(assignedGhlUserId && config.shadowTestSalesGhlIds.has(assignedGhlUserId));
  }
  if (config.productionSalesGhlIds?.size) {
    return Boolean(assignedGhlUserId && config.productionSalesGhlIds.has(assignedGhlUserId));
  }
  return true;
}

export function shouldProcessShadowLocation(config: AppConfig, locationId?: string): boolean {
  if (config.SHADOW_TEST_ENABLED) {
    return isShadowTestActive(config) && Boolean(locationId && config.shadowTestLocationIds.has(locationId));
  }
  if (config.productionLocationIds?.size) {
    return Boolean(locationId && config.productionLocationIds.has(locationId));
  }
  return true;
}

export function isEventAfterShadowStart(config: AppConfig, eventCreatedAt?: string | Date): boolean {
  if (!config.SHADOW_TEST_ENABLED) return true;
  if (!config.SHADOW_TEST_STARTED_AT || !eventCreatedAt) return false;
  const eventTime = eventCreatedAt instanceof Date ? eventCreatedAt.getTime() : Date.parse(eventCreatedAt);
  return Number.isFinite(eventTime) && eventTime >= Date.parse(config.SHADOW_TEST_STARTED_AT);
}

export function shadowSalesLabel(config: AppConfig, assignedGhlUserId?: string, assignedSalesName?: string): string {
  return (assignedGhlUserId ? config.shadowTestSalesLabels.get(assignedGhlUserId) : undefined)
    || assignedSalesName?.trim()
    || 'Assigned Sales';
}

export function prependShadowTestPrefix(
  config: AppConfig,
  text: string,
  assignedSalesName?: string,
  assignedGhlUserId?: string
): string {
  if (!isShadowTestActive(config)) return text;
  const label = shadowSalesLabel(config, assignedGhlUserId, assignedSalesName);
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
