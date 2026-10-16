import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramClient } from '../src/services/telegram.js';

describe('Telegram read-only readiness probe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses getChat without sending a message', async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      result: { id: 123456, type: 'private' }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const telegram = new TelegramClient({
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret'
    });

    await telegram.getChat('123456');

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/getChat$/);
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe('POST');
    expect(JSON.parse(String(request.body))).toEqual({ chat_id: '123456' });
  });
});
