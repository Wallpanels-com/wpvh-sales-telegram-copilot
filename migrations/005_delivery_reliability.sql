-- Additive metadata: existing notifications remain available for audit/review.
ALTER TABLE deferred_notifications
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;
