import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { BrandKey, SalesUser } from '../types.js';

export async function resolveRecipients(
  config: AppConfig,
  db: Db,
  brand: BrandKey,
  assignedGhlUserId?: string
): Promise<{ recipients: string[]; assignedSales: SalesUser | null }> {
  const recipients = new Set<string>(config.adminTelegramUserIds);
  let assignedSales: SalesUser | null = null;
  if (assignedGhlUserId) {
    assignedSales = await db.getSalesByGhlUserId(brand, assignedGhlUserId);
    if (assignedSales) recipients.add(assignedSales.telegramUserId);
  }
  return { recipients: [...recipients], assignedSales };
}

export async function canTelegramUserAccessCard(config: AppConfig, db: Db, telegramUserId: string, card: any): Promise<boolean> {
  if (config.adminTelegramUserIds.includes(telegramUserId)) return true;
  const user = await db.getSalesByTelegramId(telegramUserId);
  if (!user) return false;
  const mapped = card.brand === 'wp' ? user.wpGhlUserId : user.vhGhlUserId;
  return Boolean(mapped && mapped === card.assigned_ghl_user_id);
}
