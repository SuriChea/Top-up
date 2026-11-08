const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const { Pool } = require("pg");

const app = express();
const kind = process.env.MOCK_KIND;
const port = Number(process.env.PORT || (kind === "pay" ? 4001 : 4002));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const paymentSecret = process.env.PAYMENT_WEBHOOK_SECRET || "whsec_test_inblackm_2026";
const apiUrl = process.env.API_URL || "http://api-1:3001";
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

app.use(cors({ origin: process.env.WEB_ORIGIN || true }));
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (_req, res) => res.json({ status: "ok", service: `mock-${kind}` }));

async function deliverWebhook(body) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac("sha256", paymentSecret)
    .update(`${timestamp}.${rawBody}`).digest("hex");
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const response = await fetch(`${apiUrl}/api/v1/webhooks/payment`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-IBM-Signature": `t=${timestamp},v1=${signature}`
        },
        body: rawBody,
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return;
      lastError = new Error(`Webhook returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(1000 * (2 ** attempt), 30000) + Math.floor(Math.random() * 500));
  }
  throw lastError || new Error("Webhook delivery failed");
}

if (kind === "pay") {
  app.post("/simulate", async (req, res, next) => {
    try {
      const { orderId, amountSatang, method, mode = "success" } = req.body;
      const supportedModes = ["success", "failure", "duplicate", "delayed", "mismatch"];
      if (!orderId || !Number.isSafeInteger(amountSatang) || amountSatang < 0 ||
          !supportedModes.includes(mode)) {
        return res.status(400).json({ error: "Invalid payment simulation request" });
      }
      const body = {
        event_id: `evt_${crypto.randomUUID()}`,
        type: mode === "failure" ? "payment.failed" : "payment.succeeded",
        order_id: orderId,
        amount_satang: mode === "mismatch" ? amountSatang + 1 : amountSatang,
        currency: "THB",
        occurred_at: new Date().toISOString(),
        payment_method: method || "promptpay"
      };
      const repeat = mode === "duplicate" ? 5 : 1;
      const wait = mode === "delayed" ? 60_000 : 0;
      setTimeout(async () => {
        try {
          for (let i = 0; i < repeat; i += 1) await deliverWebhook(body);
        } catch (error) {
          console.error(JSON.stringify({ level: "error", message: "mock_webhook_failed", error: error.message }));
        }
      }, wait);
      return res.status(202).json({ status: "accepted", eventId: body.event_id, mode });
    } catch (error) {
      return next(error);
    }
  });

  app.post("/refund", async (req, res, next) => {
    try {
      const { orderId, amountSatang } = req.body;
      const refundId = typeof req.body.refundId === "string" ? req.body.refundId : `full-${orderId}`;
      if (!orderId || !Number.isSafeInteger(amountSatang) || amountSatang <= 0 ||
          !refundId || refundId.length > 200) {
        return res.status(400).json({ error: "Invalid refund request" });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const order = await client.query(
          "SELECT total_satang FROM orders WHERE id = $1 FOR UPDATE",
          [orderId]
        );
        if (!order.rows[0]) throw new Error("Refund order was not found");
        const saved = await client.query(
          "SELECT order_id, amount_satang FROM mock_payment_refunds WHERE refund_id = $1 FOR UPDATE",
          [refundId]
        );
        if (saved.rows[0]) {
          if (saved.rows[0].order_id !== orderId || Number(saved.rows[0].amount_satang) !== amountSatang) {
            throw new Error("Refund ID was reused with a different request");
          }
        } else {
          const refunded = await client.query(
            "SELECT COALESCE(SUM(amount_satang), 0)::bigint AS amount FROM mock_payment_refunds WHERE order_id = $1",
            [orderId]
          );
          if (BigInt(refunded.rows[0].amount) + BigInt(amountSatang) > BigInt(order.rows[0].total_satang)) {
            throw new Error("Refund exceeds the amount paid");
          }
          await client.query(
            `INSERT INTO mock_payment_refunds (refund_id, order_id, amount_satang)
             VALUES ($1, $2, $3)`,
            [refundId, orderId, amountSatang]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      await deliverWebhook({
        event_id: `refund_${refundId}`,
        type: "payment.refunded",
        order_id: orderId,
        amount_satang: amountSatang,
        currency: "THB",
        occurred_at: new Date().toISOString()
      });
      return res.json({ status: "refunded", refundId, orderId, amountSatang });
    } catch (error) {
      return next(error);
    }
  });
} else if (kind === "game") {
  app.post("/topups", async (req, res, next) => {
    try {
      const { reference, game_uid: gameUid, sku, qty } = req.body;
      if (!reference || !gameUid || !sku || !Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({ error: "Invalid game top-up request" });
      }
      const latency = Number(process.env.LATENCY_MS || 0);
      if (latency > 0) await delay(latency);
      if (Math.random() < Number(process.env.FAIL_RATE || 0)) {
        return res.status(503).json({ error: "Temporary game service failure" });
      }
      if (Math.random() < Number(process.env.TIMEOUT_RATE || 0)) {
        await delay(6000);
        return res.status(504).json({ error: "Game service timeout" });
      }

      const result = await pool.query(
        `INSERT INTO mock_game_topups (reference, game_uid, sku, qty)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [reference, gameUid, sku, qty]
      );
      if (Math.random() < Number(process.env.SUCCESS_BUT_TIMEOUT_RATE || 0)) {
        await delay(6000);
      }
      return res.json({ status: "succeeded", reference, deliveryId: `delivery-${result.rows[0].id}` });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/topups/:reference", async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT reference, game_uid, sku, qty, status, created_at
         FROM mock_game_topups WHERE reference = $1 ORDER BY id DESC LIMIT 1`,
        [req.params.reference]
      );
      if (!result.rows[0]) return res.status(404).json({ error: "Top-up not found" });
      return res.json(result.rows[0]);
    } catch (error) {
      return next(error);
    }
  });

  app.get("/stats", async (_req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT reference, COUNT(*)::integer AS successful_count
         FROM mock_game_topups WHERE status = 'succeeded' GROUP BY reference`
      );
      return res.json(Object.fromEntries(result.rows.map((row) => [row.reference, row.successful_count])));
    } catch (error) {
      return next(error);
    }
  });
} else {
  throw new Error("MOCK_KIND must be 'pay' or 'game'");
}

app.use((error, _req, res, _next) => {
  console.error(JSON.stringify({ level: "error", message: "mock_request_failed", error: error.message }));
  return res.status(500).json({ error: "Mock service failure" });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: `mock_${kind}_started`, port }));
});

async function shutdown() {
  server.close();
  await pool.end();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
