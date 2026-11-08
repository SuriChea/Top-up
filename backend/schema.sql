CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_satang BIGINT NOT NULL CHECK (price_satang >= 0),
  stock INTEGER NOT NULL CHECK (stock >= -1),
  max_per_order INTEGER NOT NULL DEFAULT 10 CHECK (max_per_order > 0),
  max_per_email INTEGER CHECK (max_per_email > 0),
  max_order_count INTEGER CHECK (max_order_count > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS discount_codes (
  code TEXT PRIMARY KEY,
  discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value BIGINT NOT NULL CHECK (discount_value >= 0),
  max_discount_satang BIGINT,
  min_order_satang BIGINT NOT NULL DEFAULT 0,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  player_id TEXT NOT NULL,
  sku TEXT NOT NULL REFERENCES products(sku),
  product_name TEXT NOT NULL,
  unit_price_satang BIGINT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  subtotal_satang BIGINT NOT NULL CHECK (subtotal_satang >= 0),
  discount_satang BIGINT NOT NULL CHECK (discount_satang >= 0),
  fee_satang BIGINT NOT NULL CHECK (fee_satang >= 0),
  vat_satang BIGINT NOT NULL CHECK (vat_satang >= 0),
  total_satang BIGINT NOT NULL CHECK (total_satang >= 0),
  discount_code TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('promptpay', 'truemoney', 'card')),
  status TEXT NOT NULL CHECK (status IN (
    'PENDING_PAYMENT', 'PAID', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED',
    'EXPIRED', 'PAYMENT_FAILED', 'FAILED', 'REFUNDED', 'NEEDS_REVIEW'
  )),
  payment_reference TEXT,
  game_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS orders_created_id_idx ON orders (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS orders_status_created_idx ON orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_email_created_idx ON orders (email, created_at DESC);

CREATE TABLE IF NOT EXISTS order_events (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  status TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_events_order_id_idx ON order_events (order_id, id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  status_code INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fulfillment_jobs (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fulfillment_jobs_ready_idx ON fulfillment_jobs (run_after, id)
  WHERE status IN ('queued', 'retry');

CREATE TABLE IF NOT EXISTS refund_jobs (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  amount_satang BIGINT NOT NULL CHECK (amount_satang >= 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_progress', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mock_game_topups (
  id BIGSERIAL PRIMARY KEY,
  reference TEXT NOT NULL,
  game_uid TEXT NOT NULL,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'succeeded',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO products (sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count)
VALUES
  ('DIAMOND-1000', '1,000 Diamonds', 34900, -1, 10, NULL, NULL),
  ('DIAMOND-5000', '5,000 Diamonds', 159000, -1, 10, NULL, NULL),
  ('MONTHLY-PASS', 'Monthly Pass', 17900, -1, 1, 1, NULL),
  ('FLASH-SKIN-01', 'Limited Skin (Flash Sale)', 9900, 100, 2, 2, 100)
ON CONFLICT (sku) DO UPDATE SET
  max_per_email = EXCLUDED.max_per_email,
  max_order_count = EXCLUDED.max_order_count;

INSERT INTO discount_codes
  (code, discount_type, discount_value, max_discount_satang, min_order_satang, max_uses)
VALUES
  ('SAVE10', 'percent', 10, 5000, 20000, 10),
  ('FLAT20', 'fixed', 2000, NULL, 10000, NULL)
ON CONFLICT (code) DO NOTHING;
