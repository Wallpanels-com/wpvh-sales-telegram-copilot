import { afterEach, describe, expect, it, vi } from 'vitest';
import { GhlApiError, GhlClient } from '../src/services/ghl.js';
import { EventProcessor } from '../src/services/processor.js';
import { safeErrorMessage } from '../src/security.js';

const config: any = { GHL_API_BASE: 'https://services.leadconnectorhq.com', GHL_API_VERSION: 'v3', GHL_WP_TOKEN: 'test' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('missing CRM contacts', () => {
  it('classifies an explicit contact-not-found response without exposing its payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Contact not found for id:private-contact' }), { status: 400 })));
    const promise = new GhlClient(config).getContact('wp', 'private-contact');
    await expect(promise).rejects.toMatchObject({ status: 400, reason: 'contact_unavailable' });
    await expect(promise).rejects.not.toThrow('private-contact');
  });

  it.each([400, 401, 403, 500])('keeps unrelated HTTP %s failures eligible for normal error handling', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Request rejected' }), { status })));
    await expect(new GhlClient(config).getContact('wp', 'contact-1')).rejects.toMatchObject({ reason: 'request_rejected' });
  });

  it('discards a missing-contact event without retrying or sending Telegram messages', async () => {
    vi.useFakeTimers();
    const db = {
      claimNextEvent: vi.fn().mockResolvedValueOnce({ id: 'event-1', kind: 'customer_replied', payload: {}, source: 'ghl_workflow_webhook' }).mockResolvedValue(null),
      markEventDiscarded: vi.fn(async () => undefined), markEventFailed: vi.fn(), markEventDone: vi.fn()
    };
    const telegram = { sendMessage: vi.fn() };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const processor = new EventProcessor({} as any, db as any, {} as any, telegram as any, {} as any, {} as any, logger);
    vi.spyOn(processor, 'processEvent').mockRejectedValue(new GhlApiError(400, 'contact_unavailable', 'contacts'));
    processor.start();
    await vi.advanceTimersByTimeAsync(0);
    processor.stop();
    await vi.runOnlyPendingTimersAsync();
    expect(db.markEventDiscarded).toHaveBeenCalledExactlyOnceWith('event-1', expect.any(String));
    expect(db.markEventFailed).not.toHaveBeenCalled();
    expect(db.markEventDone).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('logs only allowlisted network cause codes, never raw transport details', () => {
    expect(safeErrorMessage(new Error('fetch failed', { cause: { code: 'ECONNRESET', address: 'private-host' } }))).toBe('fetch failed (ECONNRESET)');
    expect(safeErrorMessage(new Error('fetch failed', { cause: { code: 'Bearer private-token-value' } }))).toBe('fetch failed');
  });
});
