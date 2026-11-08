ALTER TABLE products
  ADD COLUMN IF NOT EXISTS max_per_email INTEGER,
  ADD COLUMN IF NOT EXISTS max_order_count INTEGER;

UPDATE products
SET max_per_email = CASE sku
  WHEN 'MONTHLY-PASS' THEN 1
  WHEN 'FLASH-SKIN-01' THEN 2
  ELSE max_per_email
END,
max_order_count = CASE sku
  WHEN 'FLASH-SKIN-01' THEN 100
  ELSE max_order_count
END;

UPDATE discount_codes
SET max_uses = 10
WHERE code = 'SAVE10';

CREATE INDEX IF NOT EXISTS orders_sku_email_active_idx
  ON orders (sku, email);
