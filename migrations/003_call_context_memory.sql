ALTER TABLE client_memory
  ADD COLUMN IF NOT EXISTS important_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS objections jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS commitments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS next_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_call_message_id text;

CREATE TABLE IF NOT EXISTS call_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id text NOT NULL,
  contact_id text NOT NULL,
  message_id text NOT NULL,
  transcript_sha256 text NOT NULL,
  summary text NOT NULL,
  client_needs jsonb NOT NULL DEFAULT '[]'::jsonb,
  objections jsonb NOT NULL DEFAULT '[]'::jsonb,
  commitments jsonb NOT NULL DEFAULT '[]'::jsonb,
  next_steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  important_facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  relationship_summary text NOT NULL,
  ai_provider text NOT NULL,
  ai_model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, message_id)
);

CREATE INDEX IF NOT EXISTS call_summaries_contact_idx
  ON call_summaries (location_id, contact_id, created_at DESC);
