CREATE TABLE IF NOT EXISTS sales_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  telegram_user_id text UNIQUE NOT NULL,
  wp_ghl_user_id text,
  vh_ghl_user_id text,
  is_admin boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_users_wp_idx ON sales_users (wp_ghl_user_id) WHERE wp_ghl_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_users_vh_idx ON sales_users (vh_ghl_user_id) WHERE vh_ghl_user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text UNIQUE NOT NULL,
  source text NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS webhook_events_queue_idx ON webhook_events (status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS client_memory (
  location_id text NOT NULL,
  contact_id text NOT NULL,
  relationship_summary text,
  last_call_summary text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, contact_id)
);

CREATE TABLE IF NOT EXISTS ai_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  brand text NOT NULL,
  location_id text NOT NULL,
  contact_id text NOT NULL,
  conversation_id text,
  message_id text,
  assigned_ghl_user_id text,
  contact_name text,
  stage_name text,
  client_message text,
  context_summary text,
  suggested_reply text,
  next_action text,
  priority text,
  should_reply boolean,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_cards_contact_idx ON ai_cards (location_id, contact_id, created_at DESC);

CREATE TABLE IF NOT EXISTS telegram_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES ai_cards(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  telegram_message_id text,
  delivery_type text NOT NULL DEFAULT 'primary',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, telegram_user_id, delivery_type)
);

CREATE TABLE IF NOT EXISTS deferred_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid REFERENCES ai_cards(id) ON DELETE CASCADE,
  telegram_user_id text NOT NULL,
  deliver_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE(card_id, telegram_user_id)
);
CREATE INDEX IF NOT EXISTS deferred_notifications_due_idx ON deferred_notifications (status, deliver_after);

CREATE TABLE IF NOT EXISTS poll_checkpoints (
  checkpoint_key text PRIMARY KEY,
  checkpoint_value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS processed_messages (
  location_id text NOT NULL,
  message_id text NOT NULL,
  direction text,
  message_type text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(location_id, message_id)
);

CREATE TABLE IF NOT EXISTS ai_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_user_id text,
  scope text NOT NULL DEFAULT 'global',
  lesson text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
