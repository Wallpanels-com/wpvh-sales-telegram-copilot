import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { registerHighLevelRoutes } from '../src/routes/highlevel.js';

function config(): AppConfig {
  return {
    GHL_WEBHOOK_SHARED_SECRET: 'a-strong-shared-secret',
    GHL_WP_LOCATION_ID: 'wp-location',
    GHL_VH_LOCATION_ID: 'vh-location',
    WEBHOOK_RATE_LIMIT_PER_MINUTE: 300
  } as AppConfig;
}

describe('HighLevel webhook security', () => {
  it('accepts an authorized standard Webhook action and strips its secret before persistence', async () => {
    const app = Fastify();
    let saved: any;
    await registerHighLevelRoutes(app, config(), {
      enqueueEvent: async (event: any) => { saved = event; return true; }
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret&locationId=wp-location&contactId=contact-1'
    });
    expect(response.statusCode).toBe(200);
    expect(saved.payload.secret).toBeUndefined();
    expect(saved.payload.locationId).toBe('wp-location');
    await app.close();
  });

  it('rejects a missing/invalid secret and an unknown location', async () => {
    const app = Fastify();
    const db = { enqueueEvent: async () => true } as any;
    await registerHighLevelRoutes(app, config(), db);

    const missing = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?locationId=wp-location&contactId=contact-1'
    });
    expect(missing.statusCode).toBe(401);

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=wrong&locationId=wp-location&contactId=contact-1'
    });
    expect(unauthorized.statusCode).toBe(401);

    const unknownLocation = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/transcript-generated?secret=a-strong-shared-secret&locationId=other-location&contactId=contact-1'
    });
    expect(unknownLocation.statusCode).toBe(400);
    await app.close();
  });

  it('deduplicates identical event IDs at persistence', async () => {
    const app = Fastify();
    const keys = new Set<string>();
    let processed = 0;
    await registerHighLevelRoutes(app, config(), {
      enqueueEvent: async (event: any) => {
        if (keys.has(event.eventKey)) return false;
        keys.add(event.eventKey);
        processed += 1;
        return true;
      }
    } as any);
    const request = {
      method: 'POST' as const,
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret',
      payload: { locationId: 'wp-location', contactId: 'contact-1', eventId: 'event-1' }
    };
    expect((await app.inject(request)).json().accepted).toBe(true);
    expect((await app.inject(request)).json().accepted).toBe(false);
    expect(processed).toBe(1);
    await app.close();
  });

  it('accepts HighLevel timestamp punctuation in an opaque event ID without weakening resource ID validation', async () => {
    const app = Fastify();
    let saved: any;
    await registerHighLevelRoutes(app, config(), {
      enqueueEvent: async (event: any) => { saved = event; return true; }
    } as any);

    const accepted = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret&locationId=wp-location&contactId=contact-1&eventId=contact-1-202610160113002.'
    });
    expect(accepted.statusCode).toBe(200);
    expect(saved.payload.eventId).toBe('contact-1-202610160113002.');

    const unsafeResourceId = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret&locationId=wp-location&contactId=contact.1&eventId=event-1'
    });
    expect(unsafeResourceId.statusCode).toBe(400);
    await app.close();
  });

  it('safely rejects malformed JSON and oversized payloads', async () => {
    const app = Fastify();
    await registerHighLevelRoutes(app, config(), { enqueueEvent: async () => true } as any);
    const malformed = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json'
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret',
      payload: { locationId: 'wp-location', contactId: 'contact-1', padding: 'x'.repeat(1024 * 1024) }
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it('acknowledges but does not queue Verona while WallPanels-only shadow mode is active', async () => {
    const app = Fastify();
    let enqueued = false;
    const shadowConfig = {
      ...config(),
      SHADOW_TEST_ENABLED: true,
      SHADOW_TEST_UNTIL: '',
      SHADOW_TEST_STARTED_AT: '2026-10-15T10:00:00Z',
      shadowTestLocationIds: new Set(['wp-location'])
    } as AppConfig;
    await registerHighLevelRoutes(app, shadowConfig, {
      enqueueEvent: async () => { enqueued = true; return true; }
    } as any);

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=a-strong-shared-secret&locationId=vh-location&contactId=contact-1'
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, accepted: false, ignored: 'shadow_location_scope' });
    expect(enqueued).toBe(false);
    await app.close();
  });
});
