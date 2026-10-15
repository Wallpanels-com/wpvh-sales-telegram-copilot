import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

const config = loadConfig();
const db = createDb(config);
const raw = JSON.parse(config.SALES_MAPPINGS_JSON || '[]');
if (!Array.isArray(raw)) throw new Error('SALES_MAPPINGS_JSON must be a JSON array');

let seededSalesCount = 0;
for (const item of raw) {
  if (!item?.name || !item?.telegramUserId) throw new Error('Each sales mapping needs name and telegramUserId');
  await db.upsertSalesUser({
    name: String(item.name),
    telegramUserId: String(item.telegramUserId),
    wpGhlUserId: item.wpGhlUserId ? String(item.wpGhlUserId) : null,
    vhGhlUserId: item.vhGhlUserId ? String(item.vhGhlUserId) : null,
    isAdmin: Boolean(item.isAdmin)
  });
  seededSalesCount += 1;
}

let seededAdminCount = 0;
for (const adminId of config.adminTelegramUserIds) {
  const existing = await db.getSalesByTelegramId(adminId);
  if (!existing) {
    await db.upsertSalesUser({ name: `Admin ${adminId}`, telegramUserId: adminId, isAdmin: true });
    seededAdminCount += 1;
  }
}

console.log(`Sales mappings synchronized: sales=${seededSalesCount}, newAdmins=${seededAdminCount}`);
