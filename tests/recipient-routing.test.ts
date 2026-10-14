import { describe, expect, it } from 'vitest';
import { resolveRecipients } from '../src/services/recipients.js';

describe('recipient routing', () => {
  it('routes to admins and the assigned sales only', async () => {
    const config: any = { adminTelegramUserIds: ['admin1', 'admin2'] };
    const db: any = {
      getSalesByGhlUserId: async (_brand: string, id: string) => id === 'mary-ghl'
        ? { telegramUserId: 'mary-tg', name: 'Mary', wpGhlUserId: 'mary-ghl', vhGhlUserId: null, isAdmin: false, active: true, id: '1' }
        : null
    };
    const result = await resolveRecipients(config, db, 'wp', 'mary-ghl');
    expect(result.recipients.sort()).toEqual(['admin1', 'admin2', 'mary-tg'].sort());
  });

  it('routes an unassigned lead to admins only', async () => {
    const config: any = { adminTelegramUserIds: ['admin1', 'admin2'] };
    const db: any = { getSalesByGhlUserId: async () => null };
    const result = await resolveRecipients(config, db, 'wp');
    expect(result.recipients.sort()).toEqual(['admin1', 'admin2']);
    expect(result.assignedSales).toBeNull();
  });

  it('does not use a WallPanels mapping for a Verona event', async () => {
    const config: any = { adminTelegramUserIds: ['admin1'] };
    const db: any = {
      getSalesByGhlUserId: async (brand: string, id: string) => brand === 'wp' && id === 'shared-id'
        ? { telegramUserId: 'wp-sales', name: 'WP Sales', wpGhlUserId: 'shared-id', vhGhlUserId: null, isAdmin: false, active: true, id: '1' }
        : null
    };
    const result = await resolveRecipients(config, db, 'vh', 'shared-id');
    expect(result.recipients).toEqual(['admin1']);
  });
});
