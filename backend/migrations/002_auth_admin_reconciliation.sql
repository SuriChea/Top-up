CREATE TABLE IF NOT EXISTS auth_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('customer', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS otp_challenges_email_created_idx
  ON otp_challenges (email, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_expiry_idx
  ON auth_sessions (user_id, expires_at DESC) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES auth_users(id),
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx
  ON admin_audit_logs (created_at DESC, id DESC);

ALTER TABLE refund_jobs ADD COLUMN IF NOT EXISTS requested_by TEXT;
ALTER TABLE refund_jobs ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE TABLE IF NOT EXISTS reconciliation_batches (
  id TEXT PRIMARY KEY,
  uploaded_by TEXT NOT NULL REFERENCES auth_users(id),
  file_name TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  mismatch_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'completed_with_mismatches')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reconciliation_batches_created_idx
  ON reconciliation_batches (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id BIGSERIAL PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES reconciliation_batches(id) ON DELETE CASCADE,
  provider_event_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount_satang BIGINT NOT NULL CHECK (amount_satang >= 0),
  currency TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'matched', 'amount_mismatch', 'event_mismatch', 'missing_internal_event',
    'unknown_order', 'missing_provider_event'
  )),
  detail TEXT NOT NULL,
  internal_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reconciliation_items_batch_idx
  ON reconciliation_items (batch_id, id);
