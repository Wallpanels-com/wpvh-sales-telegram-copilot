import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { WebhookKind } from '../types.js';
import { shouldProcessShadowLocation } from '../services/delivery-policy.js';
import { canonicalWebhookPayload, isPlainObject, mergeQueryIntoPayload, normalizeWebhook } from '../services/webhook-normalizer.js';
import { auditRef, FixedWindowRateLimiter, isSafeExternalId, timingSafeSecretEqual } from '../security.js';

export async function registerHighLevelRoutes(app: FastifyInstance, config: AppConfig, db: Db) {
  const rateLimiter = new FixedWindowRateLimiter(config.WEBHOOK_RATE_LIMIT_PER_MINUTE ?? 300);
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
      if (!timingSafeSecretEqual(headerSecret, config.GHL_WEBHOOK_SHARED_SECRET)
        && !timingSafeSecretEqual(querySecret, config.GHL_WEBHOOK_SHARED_SECRET)) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      if (!rateLimiter.allow(request.ip)) {
        return reply.code(429).send({ ok: false, error: 'rate_limited' });
      }
      if (request.body !== undefined && !isPlainObject(request.body)) {
        return reply.code(400).send({ ok: false, error: 'invalid_request' });
      }

      const payload = mergeQueryIntoPayload(request.body, query);
      delete payload.secret;
      const n = normalizeWebhook(route.kind, payload);
      const identifiers = [n.locationId, n.contactId, n.conversationId, n.messageId, n.assignedUserId, n.voiceAiCallId, n.sourceEventId]
        .filter((value): value is string => Boolean(value));
      if (!n.locationId || !n.contactId || identifiers.some((value) => !isSafeExternalId(value))) {
        return reply.code(400).send({ ok: false, error: 'invalid_request' });
      }
      if (n.locationId !== config.GHL_WP_LOCATION_ID && n.locationId !== config.GHL_VH_LOCATION_ID) {
        return reply.code(400).send({ ok: false, error: 'invalid_request' });
      }
      app.log.info({ kind: route.kind, eventKey: n.eventKey, locationRef: auditRef(n.locationId), contactRef: auditRef(n.contactId) }, 'webhook received');
      if (!shouldProcessShadowLocation(config, n.locationId)) {
        app.log.info({ kind: route.kind, eventKey: n.eventKey, locationRef: auditRef(n.locationId) }, 'webhook ignored by shadow location scope');
        return reply.code(200).send({ ok: true, accepted: false, ignored: 'shadow_location_scope' });
      }
      const inserted = await db.enqueueEvent({
        eventKey: n.eventKey,
        source: 'ghl_workflow_webhook',
        kind: route.kind,
        payload: canonicalWebhookPayload(n)
      });
      return reply.code(200).send({ ok: true, accepted: inserted });
    });
  }
}
