import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhlPoller } from '../src/services/poller.js';
import { EventProcessor } from '../src/services/processor.js';
import { canonicalWebhookPayload, normalizeWebhook } from '../src/services/webhook-normalizer.js';

const cutoff = '2026-11-06T15:00:00.000Z';
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
afterEach(() => vi.useRealTimers());

describe('safe delivery resumption', () => {
  it('does not lose source event time when storing the canonical queue payload', () => {
    const original = normalizeWebhook('customer_replied', { timestamp: cutoff, messageId: 'new-message' });
    expect(normalizeWebhook('customer_replied', canonicalWebhookPayload(original)).eventTimestamp).toBe(cutoff);
  });

  it('clamps an October poll checkpoint and rejects old or undated export results', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-06T15:05:00Z'));
    const db = { getCheckpoint: vi.fn(async () => '2026-10-20T12:00:00Z'),
      setCheckpoint: vi.fn(), enqueueEvent: vi.fn() };
    const ghl = { locationId: () => 'wp-location', exportMessages: vi.fn(async () => ({ messages: [
      { id: 'old', contactId: 'contact', direction: 'inbound', dateAdded: '2026-10-25T15:00:00Z' },
      { id: 'undated', contactId: 'contact', direction: 'inbound' },
      { id: 'new', contactId: 'contact', direction: 'inbound', dateAdded: '2026-11-06T15:01:00Z' }
    ] })) };
    const poller = new GhlPoller({ DEFERRED_DELIVERY_RESUME_AT: cutoff } as any, db as any, ghl as any, logger);
    await (poller as any).pollChannel('wp', 'SMS');
    expect(ghl.exportMessages).toHaveBeenCalledWith('wp', expect.objectContaining({ startDate: cutoff }));
    expect(db.enqueueEvent).toHaveBeenCalledTimes(1);
    expect(db.enqueueEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ messageId: 'new' }) }));
  });

  it('ignores an old event arriving after resumption before calling CRM, AI or Telegram', async () => {
    const ghl = { getMessage: vi.fn() }; const telegram = { sendMessage: vi.fn() }; const ai = { analyzeReply: vi.fn() };
    const processor = new EventProcessor({ DEFERRED_DELIVERY_RESUME_AT: cutoff } as any,
      {} as any, ghl as any, telegram as any, ai as any, {} as any, logger);
    await processor.processEvent('customer_replied', { eventTimestamp: '2026-10-25T15:00:00Z', messageId: 'old' });
    expect(ghl.getMessage).not.toHaveBeenCalled();
    expect(ai.analyzeReply).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
