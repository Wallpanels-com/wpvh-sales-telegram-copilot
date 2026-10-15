import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertGhlApiPath, assertGhlReadOnlyMethod, GhlClient } from '../src/services/ghl.js';

const config: any = {
  GHL_WP_LOCATION_ID: 'wp-location',
  GHL_WP_TOKEN: 'wp-token',
  GHL_VH_LOCATION_ID: 'vh-location',
  GHL_VH_TOKEN: 'vh-token',
  GHL_API_BASE: 'https://services.leadconnectorhq.com',
  GHL_API_VERSION: 'v3',
  GHL_CONTACT_URL_TEMPLATE: 'https://example.test/{locationId}/{contactId}'
};

describe('HighLevel client safety', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses GET and the current v3 header for CRM reads', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ contact: { id: 'contact-1' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new GhlClient(config).getContact('wp', 'contact-1');

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(url)).toBe('https://services.leadconnectorhq.com/contacts/contact-1');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Version).toBe('v3');
  });

  it('passes the export cursor without changing the request method', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [], nextCursor: null, total: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await new GhlClient(config).exportMessages('vh', {
      channel: 'SMS',
      startDate: '2026-10-14T00:00:00.000Z',
      cursor: 'cursor-1'
    });

    const [url, init] = fetchMock.mock.calls[0]! as unknown as [RequestInfo | URL, RequestInit | undefined];
    expect(String(url)).toContain('cursor=cursor-1');
    expect(init?.method).toBe('GET');
  });
});
  it('technically blocks every non-GET method', () => {
    expect(() => assertGhlReadOnlyMethod('GET')).not.toThrow();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(() => assertGhlReadOnlyMethod(method)).toThrow(/read-only/);
    }
  });

  it('blocks protocol-relative and absolute paths to prevent SSRF', () => {
    expect(() => assertGhlApiPath('/contacts/contact-1')).not.toThrow();
    expect(() => assertGhlApiPath('//attacker.example/steal')).toThrow(/Invalid/);
    expect(() => assertGhlApiPath('https://attacker.example/steal')).toThrow(/Invalid/);
  });
