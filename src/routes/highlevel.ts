import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { WebhookKind } from '../types.js';
import { shouldProcessShadowLocation } from '../services/delivery-policy.js';
import { mergeQueryIntoPayload, normalizeWebhook } from '../services/webhook-normalizer.js';

export async function registerHighLevelRoutes(app: FastifyInstance, config: AppConfig, db: Db) {
  const routes: Array<{ path: string; kind: WebhookKind }> = [
    { path: '/webhooks/highlevel/customer-replied', kind: 'customer_replied' },
    { path: '/webhooks/highlevel/transcript-generated', kind: 'transcript_generated' },
    { path: '/webhooks/highlevel/task-reminder', kind: 'task_reminder' },
    { path: '/webhooks/highlevel/appointment-reminder', kind: 'appointment_reminder' }
  ];

  for (const route of routes) {
    app.post(route.path, { bodyLimit: 1024 * 1024 }, async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const headerSecret = String(request.headers['x-webhook-secret'] ?? '');
      const querySecret = String(query.secret ?? '');
      if (!matchesSecret(headerSecret, config.GHL_WEBHOOK_SHARED_SECRET) && !matchesSecret(querySecret, config.GHL_WEBHOOK_SHARED_SECRET)) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      const payload = mergeQueryIntoPayload(request.body, query);
      delete payload.secret;
      const n = normalizeWebhook(route.kind, payload);
      if (!n.locationId) return reply.code(400).send({ ok: false, error: 'locationId_required' });
      if (n.locationId !== config.GHL_WP_LOCATION_ID && n.locationId !== config.GHL_VH_LOCATION_ID) {
        return reply.code(403).send({ ok: false, error: 'location_not_allowed' });
      }
      app.log.info({ kind: route.kind, eventKey: n.eventKey, locationId: n.locationId, contactId: n.contactId }, 'webhook received');
      if (!shouldProcessShadowLocation(config, n.locationId)) {
        app.log.info({ kind: route.kind, eventKey: n.eventKey, locationId: n.locationId }, 'webhook ignored by shadow location scope');
        return reply.code(200).send({ ok: true, accepted: false, ignored: 'shadow_location_scope' });
      }
      const inserted = await db.enqueueEvent({
        eventKey: n.eventKey,
        source: 'ghl_workflow_webhook',
        kind: route.kind,
        payload
      });
      return reply.code(200).send({ ok: true, accepted: inserted });
    });
  }
}

function matchesSecret(candidate: string, expected: string): boolean {
  if (!candidate) return false;
  const left = createHash('sha256').update(candidate).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}
