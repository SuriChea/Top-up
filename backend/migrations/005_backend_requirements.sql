ALTER TABLE auth_users DROP CONSTRAINT IF EXISTS auth_users_role_check;
ALTER TABLE auth_users ADD CONSTRAINT auth_users_role_check
  CHECK (role IN ('customer', 'viewer', 'support', 'finance', 'superadmin', 'admin'));
ALTER TABLE auth_users ADD COLUMN IF NOT EXISTS role_source TEXT NOT NULL DEFAULT 'manual'
  CHECK (role_source IN ('manual', 'env'));
UPDATE auth_users SET role_source = 'env' WHERE role IN ('admin', 'superadmin') AND role_source = 'manual';

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS refunded_satang BIGINT NOT NULL DEFAULT 0 CHECK (refunded_satang >= 0),
  ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE idempotency_keys
  ADD COLUMN IF NOT EXISTS response_body_text TEXT,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE idempotency_keys SET expires_at = created_at + INTERVAL '24 hours' WHERE expires_at IS NULL;
ALTER TABLE idempotency_keys ALTER COLUMN expires_at SET DEFAULT (NOW() + INTERVAL '24 hours');

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL REFERENCES products(sku),
  product_name TEXT NOT NULL,
  player_id TEXT NOT NULL,
  unit_price_satang BIGINT NOT NULL CHECK (unit_price_satang >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  game_reference TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, sku)
);
CREATE INDEX IF NOT EXISTS order_items_order_id_idx ON order_items (order_id, id);

INSERT INTO order_items
  (order_id, sku, product_name, player_id, unit_price_satang, quantity, game_reference)
SELECT id, sku, product_name, player_id, unit_price_satang, quantity, id || ':' || sku
FROM orders
ON CONFLICT (order_id, sku) DO NOTHING;

ALTER TABLE refund_jobs
  ADD COLUMN IF NOT EXISTS actor_user_id TEXT REFERENCES auth_users(id),
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE refund_jobs DROP CONSTRAINT IF EXISTS refund_jobs_order_id_key;
CREATE INDEX IF NOT EXISTS refund_jobs_order_created_idx ON refund_jobs (order_id, id);

ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS otp_email_locks (
  email TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS refund_idempotency (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  refund_job_id BIGINT NOT NULL REFERENCES refund_jobs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mock_payment_refunds (
  refund_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  amount_satang BIGINT NOT NULL CHECK (amount_satang > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE reconciliation_items DROP CONSTRAINT IF EXISTS reconciliation_items_status_check;
ALTER TABLE reconciliation_items ADD CONSTRAINT reconciliation_items_status_check
  CHECK (status IN (
    'matched', 'amount_mismatch', 'event_mismatch', 'status_mismatch',
    'missing_internal_event', 'unknown_order', 'missing_provider_event'
  ));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_refunded_satang_check;
ALTER TABLE orders ADD CONSTRAINT orders_refund_amount_check
  CHECK (refunded_satang >= 0 AND refunded_satang <= total_satang);

CREATE OR REPLACE FUNCTION enforce_order_status_transition()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('PAID', 'EXPIRED', 'PAYMENT_FAILED', 'NEEDS_REVIEW')) OR
    (OLD.status = 'PAID' AND NEW.status IN ('IN_QUEUE', 'REFUNDED', 'NEEDS_REVIEW')) OR
    (OLD.status = 'IN_QUEUE' AND NEW.status IN ('IN_PROGRESS', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW')) OR
    (OLD.status = 'IN_PROGRESS' AND NEW.status IN ('IN_QUEUE', 'COMPLETED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW')) OR
    (OLD.status = 'COMPLETED' AND NEW.status IN ('REFUNDED', 'NEEDS_REVIEW')) OR
    (OLD.status = 'FAILED' AND NEW.status IN ('IN_QUEUE', 'REFUNDED', 'NEEDS_REVIEW')) OR
    (OLD.status = 'EXPIRED' AND NEW.status IN ('PAID', 'NEEDS_REVIEW')) OR
    (OLD.status = 'PAYMENT_FAILED' AND NEW.status IN ('PAID', 'NEEDS_REVIEW')) OR
    (OLD.status = 'NEEDS_REVIEW' AND NEW.status IN ('PAID', 'FAILED', 'REFUNDED')) OR
    (OLD.status = 'REFUNDED' AND NEW.status = 'NEEDS_REVIEW')
  ) THEN
    RAISE EXCEPTION 'Invalid order status transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_status_transition';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_status_transition_guard ON orders;
CREATE TRIGGER orders_status_transition_guard
  BEFORE UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION enforce_order_status_transition();

CREATE OR REPLACE FUNCTION require_order_status_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM order_events
    WHERE order_id = NEW.id AND status = NEW.status
  ) THEN
    RAISE EXCEPTION 'Order status transition requires an order_events record'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_status_event_required';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_status_event_required ON orders;
CREATE CONSTRAINT TRIGGER orders_status_event_required
  AFTER UPDATE OF status ON orders
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_order_status_event();

CREATE OR REPLACE FUNCTION reject_order_event_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'order_events_append_only';
END;
$$;

DROP TRIGGER IF EXISTS order_events_append_only_update ON order_events;
CREATE TRIGGER order_events_append_only_update
  BEFORE UPDATE OR DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION reject_order_event_mutation();

CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
CREATE INDEX IF NOT EXISTS orders_created_id_idx_cursor ON orders (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_id_idx ON orders (status, created_at DESC, id DESC);
