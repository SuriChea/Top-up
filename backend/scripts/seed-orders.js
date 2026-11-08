const { Pool } = require("pg");
const { newOrderId } = require("../domain");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const count = Number(process.argv[2] || 100_000);

async function seedOrders() {
  if (!Number.isInteger(count) || count < 1 || count > 1_000_000) {
    throw new Error("Specify a row count between 1 and 1,000,000");
  }
  const generatedOrders = Array.from({ length: count }, (_, index) => ({
    id: newOrderId(),
    sequence: index + 1
  }));
  const result = await pool.query(
    `INSERT INTO orders
      (id, email, player_id, sku, product_name, unit_price_satang, quantity,
       subtotal_satang, discount_satang, fee_satang, vat_satang, total_satang,
       payment_method, status, expires_at, created_at, updated_at)
     SELECT
       id,
       'seed-' || n || '@example.test',
       'seed-player-' || n,
       CASE WHEN n % 4 = 0 THEN 'DIAMOND-5000' ELSE 'DIAMOND-1000' END,
       CASE WHEN n % 4 = 0 THEN '5,000 Diamonds' ELSE '1,000 Diamonds' END,
       CASE WHEN n % 4 = 0 THEN 159000 ELSE 34900 END,
       1,
       CASE WHEN n % 4 = 0 THEN 159000 ELSE 34900 END,
       0, 0,
       CASE WHEN n % 4 = 0 THEN 10402 ELSE 2283 END,
       CASE WHEN n % 4 = 0 THEN 159000 ELSE 34900 END,
       'promptpay',
       (ARRAY['PENDING_PAYMENT', 'PAID', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED'])[1 + (n % 6)::integer],
       NOW() + INTERVAL '15 minutes',
       NOW() - (n * INTERVAL '1 second'),
       NOW()
     FROM jsonb_to_recordset($1::jsonb) AS generated(id text, n integer)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify(generatedOrders.map(({ id, sequence }) => ({ id, n: sequence })))]
  );
  const items = await pool.query(
    `INSERT INTO order_items
       (order_id, sku, product_name, player_id, unit_price_satang, quantity, game_reference)
     SELECT id, sku, product_name, player_id, unit_price_satang, quantity, id || ':' || sku
     FROM orders WHERE email LIKE 'seed-%@example.test'
     ON CONFLICT (order_id, sku) DO NOTHING`
  );
  console.log(JSON.stringify({ requested: count, inserted: result.rowCount, lineItems: items.rowCount }));
}

seedOrders()
  .catch((error) => {
    console.error(JSON.stringify({ level: "error", message: "seed_orders_failed", error: error.message }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
