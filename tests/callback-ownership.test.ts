import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerTelegramRoute } from '../src/routes/telegram.js';

describe('live CRM callback ownership', () => {
  it('does not generate or send a rewrite to the previous CRM owner', async () => {
    const app = Fastify();
    const cfg: any = {
      TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret',
      TELEGRAM_DELIVERY_MODE: 'allowlist', telegramAllowedUserIds: new Set(['123']),
      adminTelegramUserIds: [], SHADOW_TEST_ENABLED: false,
      productionLocationIds: new Set(['wp-location']), productionSalesGhlIds: new Set(['mary-ghl', 'jenny-ghl'])
    };
    const sales = { telegramUserId: '123', wpGhlUserId: 'mary-ghl', isAdmin: false };
    const db: any = {
      getSalesByTelegramId: vi.fn(async () => sales),
      getCard: vi.fn(async () => ({ id: '74e63d3d-04d3-4a7e-8e59-f81b3cfc4c52', brand: 'wp',
        location_id: 'wp-location', contact_id: 'contact', assigned_ghl_user_id: 'mary-ghl', suggested_reply: 'Hello.' }))
    };
    const ai: any = { rewriteText: vi.fn() };
    const telegram: any = { answerCallbackQuery: vi.fn(async () => undefined), sendMessage: vi.fn() };
    const context: any = { build: vi.fn(async () => ({ brand: 'wp', assignedGhlUserId: 'jenny-ghl' })) };
    await registerTelegramRoute(app, cfg, db, telegram, ai, context, {} as any, {} as any);
    const response = await app.inject({ method: 'POST', url: '/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-webhook-secret' },
      payload: { callback_query: { id: 'callback-1', from: { id: 123 },
        message: { chat: { id: 123, type: 'private' } },
        data: 'card:74e63d3d-04d3-4a7e-8e59-f81b3cfc4c52:rewrite' } } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(response.statusCode).toBe(200);
    expect(context.build).toHaveBeenCalled();
    expect(ai.rewriteText).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    await app.close();
  });
});
