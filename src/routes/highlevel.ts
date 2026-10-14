import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import type { WebhookKind } from '../types.js';
import { mergeQueryIntoPayload, normalizeWebhook } from '../services/webhook-normalizer.js';

export async function registerHighLevelRoutes(app: FastifyInstance, config: AppConfig, db: Db) {
  const routes: Array<{ path: string; kind: WebhookKind }> = [
    { path: '/webhooks/highlevel/customer-replied', kind: 'customer_replied' },
    { path: '/webhooks/highlevel/transcript-generated', kind: 'transcript_generated' },
    { path: '/webhooks/highlevel/task-reminder', kind: 'task_reminder' },
    { path: '/webhooks/highlevel/appointment-reminder', kind: 'appointment_reminder' }
  ];

  for (const route of routes) {
    app.post(route.path, async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, unknown>;
      const headerSecret = String(request.headers['x-webhook-secret'] ?? '');
      const querySecret = String(query.secret ?? '');
      if (headerSecret !== config.GHL_WEBHOOK_SHARED_SECRET && querySecret !== config.GHL_WEBHOOK_SHARED_SECRET) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      const payload = mergeQueryIntoPayload(request.body, query);
      delete payload.secret;
      const n = normalizeWebhook(route.kind, payload);
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
