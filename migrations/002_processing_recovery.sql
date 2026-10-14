ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

ALTER TABLE deferred_notifications
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

CREATE INDEX IF NOT EXISTS webhook_events_processing_idx
  ON webhook_events (processing_started_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS deferred_notifications_processing_idx
  ON deferred_notifications (processing_started_at)
  WHERE status = 'processing';
