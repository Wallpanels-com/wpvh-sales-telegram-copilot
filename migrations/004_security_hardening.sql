-- Terminal webhook payloads are no longer needed for processing. Remove historical
-- CRM PII while retaining event keys, timestamps and status for idempotency/audit.
UPDATE webhook_events
SET payload = '{"redacted":true}'::jsonb
WHERE status IN ('done', 'discarded', 'failed');
