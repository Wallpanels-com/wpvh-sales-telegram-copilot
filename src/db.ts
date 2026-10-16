import { neon } from '@neondatabase/serverless';
import type { AppConfig } from './config.js';
import type { BrandKey, CallAnalysis, SalesUser, WebhookKind } from './types.js';

export type Db = ReturnType<typeof createDb>;

export function createDb(config: AppConfig) {
  const sql = neon(config.DATABASE_URL);

  return {
    sql,

    async health() {
      const rows = await sql`SELECT 1 AS ok`;
      return rows[0]?.ok === 1;
    },

    async recoverStuckWork() {
      await sql`
        UPDATE webhook_events
        SET status='retry', next_attempt_at=now(), processing_started_at=NULL,
            last_error=COALESCE(last_error, 'Recovered after interrupted processing')
        WHERE status='processing' AND processing_started_at < now() - interval '15 minutes'
      `;
      await sql`
        UPDATE deferred_notifications
        SET status='pending', processing_started_at=NULL
        WHERE status='processing' AND processing_started_at < now() - interval '15 minutes'
      `;
    },

    async listSalesUsers(): Promise<SalesUser[]> {
      const rows = await sql`SELECT * FROM sales_users WHERE active = true ORDER BY name`;
      return rows.map(mapSalesUser);
    },

    async getSalesByTelegramId(telegramUserId: string): Promise<SalesUser | null> {
      const rows = await sql`SELECT * FROM sales_users WHERE telegram_user_id = ${telegramUserId} AND active = true LIMIT 1`;
      return rows[0] ? mapSalesUser(rows[0]) : null;
    },

    async getSalesByGhlUserId(brand: BrandKey, ghlUserId: string): Promise<SalesUser | null> {
      const rows = brand === 'wp'
        ? await sql`SELECT * FROM sales_users WHERE wp_ghl_user_id = ${ghlUserId} AND active = true LIMIT 1`
        : await sql`SELECT * FROM sales_users WHERE vh_ghl_user_id = ${ghlUserId} AND active = true LIMIT 1`;
      return rows[0] ? mapSalesUser(rows[0]) : null;
    },

    async upsertSalesUser(input: { name: string; telegramUserId: string; wpGhlUserId?: string | null; vhGhlUserId?: string | null; isAdmin?: boolean }) {
      await sql`
        INSERT INTO sales_users (name, telegram_user_id, wp_ghl_user_id, vh_ghl_user_id, is_admin, active)
        VALUES (${input.name}, ${input.telegramUserId}, ${input.wpGhlUserId ?? null}, ${input.vhGhlUserId ?? null}, ${input.isAdmin ?? false}, true)
        ON CONFLICT (telegram_user_id) DO UPDATE SET
          name = EXCLUDED.name,
          wp_ghl_user_id = EXCLUDED.wp_ghl_user_id,
          vh_ghl_user_id = EXCLUDED.vh_ghl_user_id,
          is_admin = EXCLUDED.is_admin,
          active = true,
          updated_at = now()
      `;
    },

    async enqueueEvent(input: { eventKey: string; source: string; kind: WebhookKind; payload: unknown }): Promise<boolean> {
      const rows = await sql`
        INSERT INTO webhook_events (event_key, source, kind, payload)
        VALUES (${input.eventKey}, ${input.source}, ${input.kind}, ${JSON.stringify(input.payload)}::jsonb)
        ON CONFLICT (event_key) DO NOTHING
        RETURNING id
      `;
      return rows.length > 0;
    },

    async claimNextEvent(): Promise<any | null> {
      const rows = await sql`
        WITH candidate AS (
          SELECT id FROM webhook_events
          WHERE status IN ('pending', 'retry') AND next_attempt_at <= now()
          ORDER BY created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE webhook_events e
        SET status = 'processing', attempts = attempts + 1, processing_started_at=now()
        FROM candidate c
        WHERE e.id = c.id
        RETURNING e.*
      `;
      return rows[0] ?? null;
    },

    async markEventDone(id: string) {
      await sql`
        UPDATE webhook_events
        SET status='done', processed_at=now(), processing_started_at=NULL, last_error=NULL,
            payload='{"redacted":true}'::jsonb
        WHERE id=${id}
      `;
    },

    async markEventDiscarded(id: string, reason: string) {
      await sql`
        UPDATE webhook_events
        SET status='discarded', processed_at=now(), processing_started_at=NULL,
            last_error=${reason.slice(0, 2000)}, payload='{"redacted":true}'::jsonb
        WHERE id=${id}
      `;
    },

    async markEventFailed(
      id: string,
      error: string,
      attempts: number,
      options: { rateLimited?: boolean; retryAfterSeconds?: number } = {}
    ) {
      const exponential = 15 * Math.pow(2, Math.max(0, attempts - 1));
      const delaySeconds = Math.min(3600, Math.max(15, exponential, options.retryAfterSeconds ?? 0));
      const next = new Date(Date.now() + delaySeconds * 1000).toISOString();
      const terminal = !options.rateLimited && attempts >= 7;
      await sql`
        UPDATE webhook_events
        SET status=${terminal ? 'failed' : 'retry'}, last_error=${error.slice(0, 2000)}, next_attempt_at=${next}, processing_started_at=NULL,
            payload=CASE WHEN ${terminal} THEN '{"redacted":true}'::jsonb ELSE payload END
        WHERE id=${id}
      `;
    },

    async getClientMemory(locationId: string, contactId: string) {
      const rows = await sql`SELECT * FROM client_memory WHERE location_id=${locationId} AND contact_id=${contactId} LIMIT 1`;
      return rows[0] ?? null;
    },

    async getLatestCallContext(locationId: string, contactId: string) {
      const rows = await sql`
        SELECT summary, client_needs, objections, commitments, next_steps, important_facts, created_at
        FROM call_summaries
        WHERE location_id=${locationId} AND contact_id=${contactId}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      return rows[0] ?? null;
    },

    async upsertClientMemory(locationId: string, contactId: string, relationshipSummary: string, lastCallSummary?: string) {
      await sql`
        INSERT INTO client_memory (location_id, contact_id, relationship_summary, last_call_summary)
        VALUES (${locationId}, ${contactId}, ${relationshipSummary}, ${lastCallSummary ?? null})
        ON CONFLICT (location_id, contact_id) DO UPDATE SET
          relationship_summary=EXCLUDED.relationship_summary,
          last_call_summary=COALESCE(EXCLUDED.last_call_summary, client_memory.last_call_summary),
          updated_at=now()
      `;
    },

    async saveCallAnalysis(input: {
      locationId: string;
      contactId: string;
      messageId: string;
      transcriptSha256: string;
      analysis: CallAnalysis;
      aiProvider: string;
      aiModel: string;
    }) {
      const needs = JSON.stringify(input.analysis.clientNeeds);
      const objections = JSON.stringify(input.analysis.objections);
      const commitments = JSON.stringify(input.analysis.commitments);
      const nextSteps = JSON.stringify(input.analysis.nextSteps);
      const importantFacts = JSON.stringify(input.analysis.importantFacts);
      await sql`
        WITH saved AS (
          INSERT INTO call_summaries (
            location_id, contact_id, message_id, transcript_sha256, summary,
            client_needs, objections, commitments, next_steps, important_facts,
            relationship_summary, ai_provider, ai_model
          ) VALUES (
            ${input.locationId}, ${input.contactId}, ${input.messageId}, ${input.transcriptSha256},
            ${input.analysis.summary}, ${needs}::jsonb, ${objections}::jsonb,
            ${commitments}::jsonb, ${nextSteps}::jsonb, ${importantFacts}::jsonb,
            ${input.analysis.relationshipSummary}, ${input.aiProvider}, ${input.aiModel}
          )
          ON CONFLICT (location_id, message_id) DO UPDATE SET
            contact_id=EXCLUDED.contact_id,
            transcript_sha256=EXCLUDED.transcript_sha256,
            summary=EXCLUDED.summary,
            client_needs=EXCLUDED.client_needs,
            objections=EXCLUDED.objections,
            commitments=EXCLUDED.commitments,
            next_steps=EXCLUDED.next_steps,
            important_facts=EXCLUDED.important_facts,
            relationship_summary=EXCLUDED.relationship_summary,
            ai_provider=EXCLUDED.ai_provider,
            ai_model=EXCLUDED.ai_model,
            updated_at=now()
          RETURNING 1
        )
        INSERT INTO client_memory (
          location_id, contact_id, relationship_summary, last_call_summary,
          important_facts, objections, commitments, next_steps, last_call_message_id
        )
        SELECT
          ${input.locationId}, ${input.contactId}, ${input.analysis.relationshipSummary},
          ${input.analysis.summary}, ${importantFacts}::jsonb, ${objections}::jsonb,
          ${commitments}::jsonb, ${nextSteps}::jsonb, ${input.messageId}
        FROM saved
        ON CONFLICT (location_id, contact_id) DO UPDATE SET
          relationship_summary=EXCLUDED.relationship_summary,
          last_call_summary=EXCLUDED.last_call_summary,
          important_facts=EXCLUDED.important_facts,
          objections=EXCLUDED.objections,
          commitments=EXCLUDED.commitments,
          next_steps=EXCLUDED.next_steps,
          last_call_message_id=EXCLUDED.last_call_message_id,
          updated_at=now()
      `;
    },

    async createCard(input: Record<string, unknown>): Promise<string> {
      const rows = await sql`
        INSERT INTO ai_cards (
          kind, brand, location_id, contact_id, conversation_id, message_id,
          assigned_ghl_user_id, contact_name, stage_name, client_message,
          context_summary, suggested_reply, next_action, priority, should_reply, payload
        ) VALUES (
          ${String(input.kind ?? 'reply')}, ${String(input.brand)}, ${String(input.locationId)}, ${String(input.contactId)},
          ${input.conversationId ? String(input.conversationId) : null}, ${input.messageId ? String(input.messageId) : null},
          ${input.assignedGhlUserId ? String(input.assignedGhlUserId) : null}, ${input.contactName ? String(input.contactName) : null},
          ${input.stageName ? String(input.stageName) : null}, ${input.clientMessage ? String(input.clientMessage) : null},
          ${input.contextSummary ? String(input.contextSummary) : null}, ${input.suggestedReply ? String(input.suggestedReply) : null},
          ${input.nextAction ? String(input.nextAction) : null}, ${input.priority ? String(input.priority) : null},
          ${Boolean(input.shouldReply)}, ${JSON.stringify(input.payload ?? {})}::jsonb
        ) RETURNING id
      `;
      return String(rows[0]?.id);
    },

    async getCard(id: string): Promise<any | null> {
      const rows = await sql`SELECT * FROM ai_cards WHERE id=${id} LIMIT 1`;
      return rows[0] ?? null;
    },

    async recordDelivery(cardId: string, telegramUserId: string, telegramMessageId: string | number, type = 'primary') {
      await sql`
        INSERT INTO telegram_deliveries (card_id, telegram_user_id, telegram_message_id, delivery_type)
        VALUES (${cardId}, ${telegramUserId}, ${String(telegramMessageId)}, ${type})
        ON CONFLICT (card_id, telegram_user_id, delivery_type) DO NOTHING
      `;
    },

    async deferDelivery(cardId: string, telegramUserId: string, deliverAfterIso: string) {
      await sql`
        INSERT INTO deferred_notifications (card_id, telegram_user_id, deliver_after)
        VALUES (${cardId}, ${telegramUserId}, ${deliverAfterIso})
        ON CONFLICT (card_id, telegram_user_id) DO UPDATE SET deliver_after=EXCLUDED.deliver_after
      `;
    },

    async claimDueDeferred(limit = 20, allowedTelegramUserIds?: string[]): Promise<any[]> {
      if (allowedTelegramUserIds && !allowedTelegramUserIds.length) return [];
      if (allowedTelegramUserIds) {
        const allowedJson = JSON.stringify(allowedTelegramUserIds);
        return await sql`
          UPDATE deferred_notifications d
          SET status='processing', processing_started_at=now()
          WHERE d.id IN (
            SELECT id FROM deferred_notifications
            WHERE status='pending' AND deliver_after <= now()
              AND telegram_user_id IN (SELECT jsonb_array_elements_text(${allowedJson}::jsonb))
            ORDER BY deliver_after
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED
          )
          RETURNING d.*
        `;
      }
      return await sql`
        UPDATE deferred_notifications d
        SET status='processing', processing_started_at=now()
        WHERE d.id IN (
          SELECT id FROM deferred_notifications
          WHERE status='pending' AND deliver_after <= now()
          ORDER BY deliver_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING d.*
      `;
    },

    async markDeferredDone(id: string) {
      await sql`UPDATE deferred_notifications SET status='done', delivered_at=now(), processing_started_at=NULL WHERE id=${id}`;
    },

    async markDeferredPending(id: string) {
      await sql`UPDATE deferred_notifications SET status='pending', processing_started_at=NULL WHERE id=${id}`;
    },

    async getCheckpoint(key: string): Promise<string | null> {
      const rows = await sql`SELECT checkpoint_value FROM poll_checkpoints WHERE checkpoint_key=${key} LIMIT 1`;
      return rows[0]?.checkpoint_value ? String(rows[0].checkpoint_value) : null;
    },

    async setCheckpoint(key: string, value: string) {
      await sql`
        INSERT INTO poll_checkpoints (checkpoint_key, checkpoint_value)
        VALUES (${key}, ${value})
        ON CONFLICT (checkpoint_key) DO UPDATE SET checkpoint_value=EXCLUDED.checkpoint_value, updated_at=now()
      `;
    },

    async markMessageProcessed(locationId: string, messageId: string, direction?: string, messageType?: string): Promise<boolean> {
      const rows = await sql`
        INSERT INTO processed_messages (location_id, message_id, direction, message_type)
        VALUES (${locationId}, ${messageId}, ${direction ?? null}, ${messageType ?? null})
        ON CONFLICT (location_id, message_id) DO NOTHING
        RETURNING message_id
      `;
      return rows.length > 0;
    },

    async unmarkMessageProcessed(locationId: string, messageId: string) {
      await sql`DELETE FROM processed_messages WHERE location_id=${locationId} AND message_id=${messageId}`;
    },

    async getLessons(telegramUserId?: string): Promise<string[]> {
      const rows = telegramUserId
        ? await sql`SELECT lesson FROM ai_lessons WHERE active=true AND (scope='global' OR telegram_user_id=${telegramUserId}) ORDER BY created_at DESC LIMIT 30`
        : await sql`SELECT lesson FROM ai_lessons WHERE active=true AND scope='global' ORDER BY created_at DESC LIMIT 30`;
      return rows.map((r) => String(r.lesson));
    }
  };
}

function mapSalesUser(row: any): SalesUser {
  return {
    id: String(row.id),
    name: String(row.name),
    telegramUserId: String(row.telegram_user_id),
    wpGhlUserId: row.wp_ghl_user_id ? String(row.wp_ghl_user_id) : null,
    vhGhlUserId: row.vh_ghl_user_id ? String(row.vh_ghl_user_id) : null,
    isAdmin: Boolean(row.is_admin),
    active: Boolean(row.active)
  };
}
