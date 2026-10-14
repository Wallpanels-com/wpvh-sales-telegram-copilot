import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { BrandKey, SalesUser } from '../types.js';
import { isShadowTestActive } from './delivery-policy.js';

export async function resolveRecipients(
  config: AppConfig,
  db: Db,
  brand: BrandKey,
  assignedGhlUserId?: string
): Promise<{ recipients: string[]; assignedSales: SalesUser | null }> {
  const recipients = new Set<string>();
  let assignedSales: SalesUser | null = null;
  if (assignedGhlUserId) {
    assignedSales = await db.getSalesByGhlUserId(brand, assignedGhlUserId);
  }
  if (config.SHADOW_TEST_ENABLED) {
    if (isShadowTestActive(config) && assignedGhlUserId && config.shadowTestSalesGhlIds.has(assignedGhlUserId)) {
      recipients.add(config.SHADOW_TEST_RECIPIENT_TELEGRAM_ID);
    }
  } else {
    config.adminTelegramUserIds.forEach((id) => recipients.add(id));
    if (assignedSales) recipients.add(assignedSales.telegramUserId);
  }
  return { recipients: [...recipients], assignedSales };
}

export async function canTelegramUserAccessCard(config: AppConfig, db: Db, telegramUserId: string, card: any): Promise<boolean> {
  if (config.SHADOW_TEST_ENABLED) {
    return isShadowTestActive(config) && telegramUserId === config.SHADOW_TEST_RECIPIENT_TELEGRAM_ID;
  }
  if (config.adminTelegramUserIds.includes(telegramUserId)) return true;
  const user = await db.getSalesByTelegramId(telegramUserId);
  if (!user) return false;
  const mapped = card.brand === 'wp' ? user.wpGhlUserId : user.vhGhlUserId;
  return Boolean(mapped && mapped === card.assigned_ghl_user_id);
}
