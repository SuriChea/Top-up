const { Pool } = require("pg");
const Redis = require("ioredis");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
  maxRetriesPerRequest: 1,
  retryStrategy: (attempt) => Math.min(attempt * 1000, 10000)
});
const gameUrl = process.env.MOCK_GAME_URL || "http://mock-game:4002";
const payUrl = process.env.MOCK_PAY_URL || "http://mock-pay:4001";
const maxAttempts = Number(process.env.WORKER_MAX_ATTEMPTS || 8);

async function publish(event) {
  try {
    await redis.publish(`order:${event.order_id}`, JSON.stringify(event));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "event_publish_failed", error: error.message }));
  }
}

async function setStatus(client, orderId, status, reason) {
  await client.query("UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1", [orderId, status]);
  const result = await client.query(
    `INSERT INTO order_events (order_id, status, actor, reason)
     VALUES ($1, $2, 'worker', $3) RETURNING id, order_id, status, actor, reason, created_at`,
    [orderId, status, reason]
  );
  return result.rows[0];
}

async function expireOrders() {
  const client = await pool.connect();
  const events = [];
  try {
    await client.query("BEGIN");
    const orders = await client.query(
      `SELECT id, sku, quantity, discount_code FROM orders
       WHERE status = 'PENDING_PAYMENT' AND expires_at <= NOW()
       ORDER BY expires_at FOR UPDATE SKIP LOCKED LIMIT 20`
    );
    for (const order of orders.rows) {
      await client.query("UPDATE products SET stock = stock + $1 WHERE sku = $2 AND stock <> -1", [
        order.quantity,
        order.sku
      ]);
      if (order.discount_code) {
        await client.query(
          "UPDATE discount_codes SET uses_count = GREATEST(0, uses_count - 1) WHERE code = $1",
          [order.discount_code]
        );
      }
      events.push(await setStatus(client, order.id, "EXPIRED", "Payment window expired"));
    }
    await client.query(
      `UPDATE fulfillment_jobs SET status = 'retry', run_after = NOW(), locked_at = NULL,
       last_error = 'Worker lease expired' WHERE status = 'in_progress'
       AND locked_at < NOW() - INTERVAL '2 minutes'`
    );
    await client.query(
      `UPDATE refund_jobs SET status = 'retry', run_after = NOW()
       WHERE status = 'in_progress' AND run_after < NOW() - INTERVAL '2 minutes'`
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const event of events) await publish(event);
}

async function claimJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT j.id, j.order_id, j.attempts, o.sku, o.quantity, o.player_id, o.status
       FROM fulfillment_jobs j JOIN orders o ON o.id = j.order_id
       WHERE j.status IN ('queued', 'retry') AND j.run_after <= NOW()
         AND o.status IN ('PAID', 'IN_QUEUE', 'IN_PROGRESS')
       ORDER BY j.run_after, j.id FOR UPDATE OF j, o SKIP LOCKED LIMIT 1`
    );
    if (!result.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    const job = result.rows[0];
    await client.query(
      `UPDATE fulfillment_jobs SET status = 'in_progress', attempts = attempts + 1,
       locked_at = NOW() WHERE id = $1`,
      [job.id]
    );
    const events = [];
    if (job.status === "PAID") {
      events.push(await setStatus(client, job.order_id, "IN_QUEUE", "Fulfillment queued"));
    }
    if (job.status !== "IN_PROGRESS") {
      events.push(await setStatus(client, job.order_id, "IN_PROGRESS", "Game top-up started"));
    }
    await client.query("COMMIT");
    for (const event of events) await publish(event);
    return { ...job, attempts: Number(job.attempts) + 1 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getTopup(reference) {
  const response = await fetch(`${gameUrl}/topups/${encodeURIComponent(reference)}`, {
    signal: AbortSignal.timeout(4000)
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Mock game lookup returned HTTP ${response.status}`);
  return response.json();
}

async function processJob(job) {
  const client = await pool.connect();
  let event;
  const retryEvents = [];
  try {
    const orderResult = await client.query("SELECT game_reference FROM orders WHERE id = $1", [job.order_id]);
    if (!orderResult.rows[0]) throw new Error("Order disappeared before fulfillment");

    let delivery = await getTopup(job.order_id);
    if (!delivery || delivery.status !== "succeeded") {
      const response = await fetch(`${gameUrl}/topups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reference: job.order_id,
          game_uid: job.player_id,
          sku: job.sku,
          qty: job.quantity
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) throw new Error(`Mock game returned HTTP ${response.status}`);
      delivery = await response.json();
      if (delivery.status !== "succeeded") throw new Error("Game top-up was not confirmed");
    }

    await client.query("BEGIN");
    const lockedOrder = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [job.order_id]);
    await client.query(
      "UPDATE orders SET game_reference = $2 WHERE id = $1",
      [job.order_id, delivery.reference]
    );
    await client.query("UPDATE fulfillment_jobs SET status = 'done', locked_at = NULL WHERE id = $1", [job.id]);
    if (lockedOrder.rows[0] && ["IN_PROGRESS", "IN_QUEUE"].includes(lockedOrder.rows[0].status)) {
      event = await setStatus(client, job.order_id, "COMPLETED", "Game top-up confirmed");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    await client.query("BEGIN");
    const currentOrder = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [job.order_id]);
    const canRetry = currentOrder.rows[0] &&
      ["PAID", "IN_QUEUE", "IN_PROGRESS"].includes(currentOrder.rows[0].status);
    if (!canRetry) {
      await client.query(
        "UPDATE fulfillment_jobs SET status = 'dead', locked_at = NULL, last_error = $2 WHERE id = $1",
        [job.id, "Order is no longer eligible for fulfillment"]
      );
    } else if (job.attempts >= maxAttempts) {
      await client.query(
        "UPDATE fulfillment_jobs SET status = 'dead', locked_at = NULL, last_error = $2 WHERE id = $1",
        [job.id, error.message]
      );
      event = await setStatus(client, job.order_id, "FAILED", "Fulfillment exhausted retries");
      await client.query(
        "INSERT INTO refund_jobs (order_id, amount_satang) SELECT id, total_satang FROM orders WHERE id = $1 ON CONFLICT DO NOTHING",
        [job.order_id]
      );
    } else {
      const delay = Math.min(300, 2 ** job.attempts) * (0.5 + Math.random());
      await client.query(
        `UPDATE fulfillment_jobs SET status = 'retry', locked_at = NULL,
         run_after = NOW() + ($2 * INTERVAL '1 second'), last_error = $3 WHERE id = $1`,
        [job.id, delay, error.message]
      );
      retryEvents.push(await setStatus(client, job.order_id, "IN_QUEUE", "Fulfillment retry scheduled"));
      console.error(JSON.stringify({
        level: "warn",
        order_id: job.order_id,
        attempt: job.attempts,
        message: "fulfillment_retry_scheduled",
        error: error.message
      }));
    }
    await client.query("COMMIT");
  } finally {
    client.release();
  }
  for (const retryEvent of retryEvents) await publish(retryEvent);
  if (event) await publish(event);
}

async function processRefund() {
  const client = await pool.connect();
  let refund;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT id, order_id, amount_satang FROM refund_jobs
       WHERE status IN ('queued', 'retry') AND run_after <= NOW()
       ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`
    );
    refund = result.rows[0];
    if (!refund) {
      await client.query("COMMIT");
      return;
    }
    await client.query(
      "UPDATE refund_jobs SET status = 'in_progress', attempts = attempts + 1, run_after = NOW() WHERE id = $1",
      [refund.id]
    );
    await client.query("COMMIT");
    const response = await fetch(`${payUrl}/refund`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: refund.order_id, amountSatang: Number(refund.amount_satang) }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`Payment refund returned HTTP ${response.status}`);
    await pool.query("UPDATE refund_jobs SET status = 'done' WHERE id = $1", [refund.id]);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (refund) {
      const state = await pool.query("SELECT attempts FROM refund_jobs WHERE id = $1", [refund.id]);
      const attempts = Number(state.rows[0]?.attempts || 0);
      if (attempts >= maxAttempts) {
        await pool.query(
          "UPDATE refund_jobs SET status = 'dead' WHERE id = $1",
          [refund.id]
        );
      } else {
        const delay = Math.min(300, 2 ** attempts) * (0.5 + Math.random());
        await pool.query(
          `UPDATE refund_jobs SET status = 'retry', run_after = NOW() + ($2 * INTERVAL '1 second')
           WHERE id = $1`,
          [refund.id, delay]
        );
      }
    }
    console.error(JSON.stringify({ level: "error", message: "automatic_refund_failed", error: error.message }));
  } finally {
    client.release();
  }
}

async function run() {
  for (;;) {
    try {
      await expireOrders();
      const job = await claimJob();
      if (job) {
        await processJob(job);
        continue;
      }
      await processRefund();
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "worker_loop_failed", error: error.message }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function shutdown() {
  await Promise.all([pool.end(), redis.quit().catch(() => {})]);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
