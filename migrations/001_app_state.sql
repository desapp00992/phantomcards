-- Non-destructive shared persistence for Site A, Site B, and bundle orders.
-- Each service keeps its existing JSON data shape inside its own namespace so
-- the payment and marketplace business rules do not need to be redesigned.
CREATE TABLE IF NOT EXISTS app_state (
  namespace text PRIMARY KEY,
  state_version bigint NOT NULL DEFAULT 1,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_blobs (
  namespace text NOT NULL,
  user_id text NOT NULL,
  storage_key text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 5242880),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, user_id, storage_key)
);

CREATE INDEX IF NOT EXISTS app_blobs_namespace_user_idx
  ON app_blobs (namespace, user_id);
