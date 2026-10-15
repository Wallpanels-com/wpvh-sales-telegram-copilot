import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { registerHighLevelRoutes } from '../src/routes/highlevel.js';

function config(): AppConfig {
  return {
    GHL_WEBHOOK_SHARED_SECRET: 'a-strong-shared-secret',
    GHL_WP_LOCATION_ID: 'wp-location',
    GHL_VH_LOCATION_ID: 'vh-location'
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

  it('rejects an invalid secret and an unknown location', async () => {
    const app = Fastify();
    const db = { enqueueEvent: async () => true } as any;
    await registerHighLevelRoutes(app, config(), db);

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/customer-replied?secret=wrong&locationId=wp-location&contactId=contact-1'
    });
    expect(unauthorized.statusCode).toBe(401);

    const unknownLocation = await app.inject({
      method: 'POST',
      url: '/webhooks/highlevel/transcript-generated?secret=a-strong-shared-secret&locationId=other-location&contactId=contact-1'
    });
    expect(unknownLocation.statusCode).toBe(403);
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
