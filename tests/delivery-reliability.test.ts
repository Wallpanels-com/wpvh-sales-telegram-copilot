import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { EventProcessor } from '../src/services/processor.js';
import { TelegramApiError, TelegramClient, deliveryFailurePolicy } from '../src/services/telegram.js';
import { BriefingService } from '../src/services/briefing.js';
import { SchedulerService } from '../src/services/scheduler.js';

const cfg = () => ({
  TELEGRAM_DELIVERY_MODE: 'allowlist', SHADOW_TEST_ENABLED: false,
  telegramAllowedUserIds: new Set(['admin', 'mary', 'jenny']), adminTelegramUserIds: ['admin'],
  productionSalesGhlIds: new Set(['mary-ghl', 'anton-ghl', 'jenny-ghl']),
  productionLocationIds: new Set(['wp-location']),
  GHL_WP_LOCATION_ID: 'wp-location', GHL_VH_LOCATION_ID: 'vh-location',
  TIMEZONE: 'America/New_York', WORK_START: '08:45', WORK_END: '20:00',
  workDays: new Set([1, 2, 3, 4, 5, 6]), MAX_OPPORTUNITY_PAGES_PER_SALES: 1
}) as unknown as AppConfig;

function harness() {
  const config = cfg();
  const card = { id: 'card-1', kind: 'task', brand: 'wp', location_id: 'wp-location',
    contact_id: 'contact-1', assigned_ghl_user_id: 'mary-ghl', contact_name: 'Client',
    next_action: 'Follow up', payload: {}, context_summary: 'Known context' };
  const db = {
    recoverStuckDeferred: vi.fn(async (): Promise<void> => undefined),
    claimDueDeferred: vi.fn().mockResolvedValueOnce([{ id: 'delivery-1', card_id: card.id, telegram_user_id: 'mary', attempts: 1 }]).mockResolvedValue([]),
    getCard: vi.fn(async () => card), hasDelivery: vi.fn(async () => false),
    getSalesByGhlUserId: vi.fn(async (_brand: string, id: string) => ({ telegramUserId: id === 'mary-ghl' ? 'mary' : 'jenny', name: 'Sales' })),
    markDeferredDone: vi.fn(async () => undefined), finishDeferred: vi.fn(async () => undefined),
    retryDeferred: vi.fn(async () => undefined), recordDelivery: vi.fn(async () => undefined),
    recordDeliveryIssue: vi.fn(async () => undefined)
  };
  const contextService = { build: vi.fn(async () => ({
    brand: 'wp', locationId: 'wp-location', assignedGhlUserId: 'mary-ghl',
    recentMessages: [], openTasks: []
  })) };
  const telegram = { sendMessage: vi.fn(async () => ({ message_id: 123 })) };
  const ghl = { brandLabel: () => 'WallPanels', contactUrl: () => 'https://app.gohighlevel.com/contact/test' };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = new EventProcessor(config, db as any, ghl as any, telegram as any, {} as any, contextService as any, logger);
  return { processor, config, db, telegram, contextService, card, logger };
}

describe('delivery reliability', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T15:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('does not run overlapping deferred workers', async () => {
    const h = harness();
    let release!: () => void;
    h.db.recoverStuckDeferred.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const first = h.processor.deliverDeferredNow();
    await h.processor.deliverDeferredNow();
    expect(h.db.recoverStuckDeferred).toHaveBeenCalledTimes(1);
    release(); await first;
    expect(h.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.db.claimDueDeferred).toHaveBeenCalledWith(1, ['admin', 'mary', 'jenny']);
  });

  it('does not resend a card already delivered to the same recipient', async () => {
    const h = harness(); h.db.hasDelivery.mockResolvedValue(true);
    await h.processor.deliverDeferredNow();
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
    expect(h.db.markDeferredDone).toHaveBeenCalledWith('delivery-1');
  });

  it('does not deliver a previous owner card after CRM reassignment', async () => {
    const h = harness();
    h.contextService.build.mockResolvedValue({ brand: 'wp', locationId: 'wp-location', assignedGhlUserId: 'jenny-ghl', recentMessages: [], openTasks: [] });
    await h.processor.deliverDeferredNow();
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
    expect(h.db.finishDeferred).toHaveBeenCalledWith('delivery-1', 'superseded', expect.any(String));
  });

  it('stops retrying explicit permanent Telegram errors', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValue(new TelegramApiError(400, 'invalid_button'));
    await h.processor.deliverDeferredNow();
    expect(h.db.finishDeferred).toHaveBeenCalledWith('delivery-1', 'failed', expect.any(String));
    expect(h.db.retryDeferred).not.toHaveBeenCalled();
  });

  it('backs off safely on an explicit Telegram rate limit', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValue(new TelegramApiError(429, 'api_rejected', 120));
    await h.processor.deliverDeferredNow();
    expect(h.db.retryDeferred).toHaveBeenCalledWith('delivery-1', 1, expect.any(String), 120);
  });

  it('holds ambiguous transport outcomes instead of automatically sending again', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValue(new Error('timeout'));
    await h.processor.deliverDeferredNow();
    expect(h.db.finishDeferred).toHaveBeenCalledWith('delivery-1', 'uncertain', 'timeout');
    expect(h.db.retryDeferred).not.toHaveBeenCalled();
  });

  it('holds a successful send when recording it fails', async () => {
    const h = harness(); h.db.recordDelivery.mockRejectedValue(new Error('database unavailable'));
    await h.processor.deliverDeferredNow();
    expect(h.telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.db.finishDeferred).toHaveBeenCalledWith('delivery-1', 'uncertain', expect.any(String));
  });

  it('preserves a failed primary delivery for review', async () => {
    const h = harness(); h.telegram.sendMessage.mockRejectedValue(new TelegramApiError(403, 'bot_blocked'));
    await (h.processor as any).deliverOrDefer('card-1', ['mary'], 'Hello', []);
    expect(h.db.recordDeliveryIssue).toHaveBeenCalledWith('card-1', 'mary', 'failed', expect.any(String), 0);
  });

  it('respects quiet hours when draining the queue', async () => {
    const h = harness(); vi.setSystemTime(new Date('2026-11-08T15:00:00Z'));
    await h.processor.deliverDeferredNow();
    expect(h.db.claimDueDeferred).not.toHaveBeenCalled();
    expect(h.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('classifies API rejection without exposing Telegram error payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error_code: 400,
      description: 'Bad Request: BUTTON_URL_INVALID private-CRM-payload' }), { status: 400 })));
    const t = new TelegramClient({ TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_WEBHOOK_SECRET: 'test' });
    await expect(t.sendMessage({ chatId: '1', text: 'test' })).rejects.toThrow('invalid_button');
    expect(deliveryFailurePolicy(new Error('network')).status).toBe('uncertain');
  });

  it('limits daily brief queries to configured sales and locations', async () => {
    const config = cfg();
    const user = { id: 'mary', name: 'Mary', telegramUserId: 'mary', wpGhlUserId: 'mary-ghl', vhGhlUserId: 'mary-ghl', isAdmin: false, active: true };
    const ghl = { locationId: (brand: string) => brand === 'wp' ? 'wp-location' : 'vh-location', searchOpportunities: vi.fn(async () => ({ opportunities: [] })) };
    const service = new BriefingService(config, { listSalesUsers: async () => [user, { ...user, wpGhlUserId: 'other', vhGhlUserId: 'other' }] } as any, ghl as any);
    expect(await service.allSales()).toEqual([user]);
    await service.forSales(user);
    expect(ghl.searchOpportunities).toHaveBeenCalledTimes(1);
    expect(ghl.searchOpportunities).toHaveBeenCalledWith('wp', expect.any(Object));
  });

  it('keeps admin brief copies when the sales recipient is disabled', async () => {
    const config = cfg(); const sendMessage = vi.fn(async () => ({}));
    const brief = { allSales: async () => [{ id: 'anton', telegramUserId: 'anton' }], forSales: vi.fn(async () => ({ text: 'Brief' })) };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const scheduler = new SchedulerService(config, {} as any, { sendMessage } as any, brief as any, {} as any, logger);
    await scheduler.sendDailyBriefs();
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith({ chatId: 'admin', text: 'Brief' });
  });
});
