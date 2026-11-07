const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const nodemailer = require("nodemailer");
const { Pool } = require("pg");
const Redis = require("ioredis");
const { calculateTotals, newOrderId, validOrderId } = require("./domain");
const {
  cookieValue,
  generateOtp,
  hashOtp,
  hashSessionToken,
  normalizeEmail,
  safeEqualHex,
  validEmail
} = require("./auth");
const { compareSettlement, parseCsv } = require("./reconciliation");

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
  retryStrategy: () => null
});
const paymentSecret = process.env.PAYMENT_WEBHOOK_SECRET || "whsec_test_inblackm_2026";
const trackingSecret = process.env.TRACKING_TOKEN_SECRET || paymentSecret;
const authSecret = process.env.AUTH_SECRET || trackingSecret;
const orderTtlSeconds = Number(process.env.ORDER_TTL_SECONDS || 900);
const sessionCookieName = "inblack_session";
const sessionLifetimeSeconds = 12 * 60 * 60;
const configuredAdminEmails = new Set(
  (process.env.ADMIN_EMAILS || "").split(",").map(normalizeEmail).filter(Boolean)
);
const allowedOrigins = new Set(
  (process.env.WEB_ORIGIN || "http://localhost:3000,http://localhost:3005")
    .split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean)
);
const mailer = nodemailer.createTransport({
  host: process.env.MAIL_HOST || "mailpit",
  port: Number(process.env.MAIL_PORT || 1025),
  secure: process.env.MAIL_SECURE === "true",
  ...(process.env.MAIL_USER ? {
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASSWORD || "" }
  } : {}),
  connectionTimeout: 5000,
  greetingTimeout: 5000,
  socketTimeout: 8000
});

class HttpError extends Error {
  constructor(status, code, detail, retryAfter) {
    super(detail);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin.replace(/\/$/, ""))) return callback(null, true);
    return callback(new Error("Origin is not allowed"));
  },
  credentials: true
}));
app.use((req, res, next) => {
  const requestId = req.get("x-request-id") || crypto.randomUUID();
  req.requestId = requestId;
  res.set("x-request-id", requestId);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  next();
});
app.use("/api/v1/webhooks/payment", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

function problem(res, status, code, detail) {
  return res.status(status).type("application/problem+json").json({
    type: "about:blank",
    title: code.replaceAll("_", " "),
    status,
    code,
    detail
  });
}

function parseOrderInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_REQUEST", "A JSON request body is required");
  }
  const sku = typeof body.sku === "string" ? body.sku.trim().toUpperCase() : "";
  const quantity = Number(body.quantity);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const playerId = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const discountCode = typeof body.discountCode === "string" && body.discountCode.trim()
    ? body.discountCode.trim().toUpperCase() : null;
  const paymentMethod = body.paymentMethod || "promptpay";

  if (!sku) throw new HttpError(400, "SKU_REQUIRED", "A product SKU is required");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new HttpError(400, "INVALID_QUANTITY", "Quantity must be between 1 and 10");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
  }
  if (!playerId || playerId.length > 100) {
    throw new HttpError(400, "INVALID_PLAYER_ID", "Enter a valid game UID");
  }
  if (!["promptpay", "truemoney", "card"].includes(paymentMethod)) {
    throw new HttpError(400, "INVALID_PAYMENT_METHOD", "Choose a supported payment method");
  }
  return { sku, quantity, email, playerId, discountCode, paymentMethod };
}

function formatOrder(row) {
  return {
    id: row.id,
    sku: row.sku,
    productName: row.product_name,
    quantity: row.quantity,
    email: row.email,
    playerId: row.player_id,
    subtotalSatang: Number(row.subtotal_satang),
    discountSatang: Number(row.discount_satang),
    feeSatang: Number(row.fee_satang),
    vatSatang: Number(row.vat_satang),
    totalSatang: Number(row.total_satang),
    discountCode: row.discount_code,
    paymentMethod: row.payment_method,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function signTrackToken(id, email) {
  const payload = Buffer.from(JSON.stringify({
    id,
    email,
    expires: Date.now() + 15 * 60 * 1000
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", trackingSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyTrackToken(token, id) {
  if (typeof token !== "string") return false;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) return false;
  const expected = crypto.createHmac("sha256", trackingSecret).update(payload).digest();
  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.id === id && data.expires > Date.now();
  } catch {
    return false;
  }
}

async function recordStatus(client, id, status, actor, reason) {
  await client.query(
    "UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1",
    [id, status]
  );
  const result = await client.query(
    `INSERT INTO order_events (order_id, status, actor, reason)
     VALUES ($1, $2, $3, $4) RETURNING id, status, actor, reason, created_at`,
    [id, status, actor, reason]
  );
  return result.rows[0];
}

async function publishOrderEvent(event) {
  try {
    if (redis.status === "wait") await redis.connect();
    await redis.publish(`order:${event.order_id}`, JSON.stringify(event));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "event_publish_failed", error: error.message }));
  }
}

async function applyWebhook(body) {
  if (!body || !validOrderId(body.order_id)) {
    throw new HttpError(400, "INVALID_ORDER_ID", "The order ID is invalid");
  }
  if (!["payment.succeeded", "payment.failed", "payment.refunded"].includes(body.type)) {
    throw new HttpError(400, "INVALID_EVENT_TYPE", "The payment event type is not supported");
  }
  if (typeof body.event_id !== "string" || !body.event_id) {
    throw new HttpError(400, "INVALID_EVENT_ID", "The payment event ID is required");
  }
  if (body.currency !== "THB" || !Number.isSafeInteger(body.amount_satang) || body.amount_satang < 0) {
    throw new HttpError(400, "INVALID_PAYMENT_AMOUNT", "The payment amount is invalid");
  }

  const client = await pool.connect();
  let publishedEvent;
  try {
    await client.query("BEGIN");
    const duplicate = await client.query(
      `INSERT INTO payment_webhook_events (event_id, order_id, event_type, payload)
       VALUES ($1, $2, $3, $4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [body.event_id, body.order_id, body.type, JSON.stringify(body)]
    );
    if (!duplicate.rowCount) {
      const previous = await client.query(
        "SELECT payload = $2::jsonb AS same_payload FROM payment_webhook_events WHERE event_id = $1",
        [body.event_id, JSON.stringify(body)]
      );
      if (!previous.rows[0]?.same_payload) {
        throw new HttpError(409, "WEBHOOK_EVENT_ID_REUSED", "The event ID was reused with a different payload");
      }
      await client.query("COMMIT");
      return;
    }

    const orderResult = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [body.order_id]);
    const order = orderResult.rows[0];
    if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "The order was not found");

    if (BigInt(body.amount_satang) !== BigInt(order.total_satang)) {
      publishedEvent = await recordStatus(client, order.id, "NEEDS_REVIEW", "payment", "Payment amount mismatch");
    } else if (body.type === "payment.succeeded") {
      if (order.status === "EXPIRED" || order.status === "PAYMENT_FAILED") {
        const stock = await client.query(
          "UPDATE products SET stock = CASE WHEN stock = -1 THEN -1 ELSE stock - $1 END WHERE sku = $2 AND (stock = -1 OR stock >= $1)",
          [order.quantity, order.sku]
        );
        let discountAvailable = true;
        if (stock.rowCount === 1 && order.discount_code) {
          const discount = await client.query(
            "SELECT max_uses, uses_count, active FROM discount_codes WHERE code = $1 FOR UPDATE",
            [order.discount_code]
          );
          const priorUse = await client.query(
            `SELECT 1 FROM orders WHERE discount_code = $1 AND email = $2
             AND id <> $3 AND status NOT IN ('EXPIRED', 'PAYMENT_FAILED', 'FAILED', 'REFUNDED')
             LIMIT 1`,
            [order.discount_code, order.email, order.id]
          );
          discountAvailable = Boolean(discount.rows[0]?.active) &&
            (discount.rows[0].max_uses === null || discount.rows[0].uses_count < discount.rows[0].max_uses) &&
            !priorUse.rowCount;
          if (discountAvailable) {
            await client.query(
              "UPDATE discount_codes SET uses_count = uses_count + 1 WHERE code = $1",
              [order.discount_code]
            );
          }
        }
        if (stock.rowCount !== 1 || !discountAvailable) {
          if (stock.rowCount === 1 && order.sku) {
            await client.query(
              "UPDATE products SET stock = CASE WHEN stock = -1 THEN -1 ELSE stock + $1 END WHERE sku = $2",
              [order.quantity, order.sku]
            );
          }
          await client.query(
            `INSERT INTO refund_jobs (order_id, amount_satang)
             VALUES ($1, $2) ON CONFLICT (order_id) DO NOTHING`,
            [order.id, order.total_satang]
          );
          publishedEvent = await recordStatus(
            client,
            order.id,
            "NEEDS_REVIEW",
            "payment",
            "Late payment could not be fulfilled; refund queued"
          );
        } else {
          publishedEvent = await recordStatus(client, order.id, "PAID", "payment", "Late payment accepted and stock reserved");
          await client.query("INSERT INTO fulfillment_jobs (order_id) VALUES ($1) ON CONFLICT DO NOTHING", [order.id]);
        }
      } else if (order.status === "PENDING_PAYMENT") {
        publishedEvent = await recordStatus(client, order.id, "PAID", "payment", "Payment confirmed");
        await client.query("INSERT INTO fulfillment_jobs (order_id) VALUES ($1) ON CONFLICT DO NOTHING", [order.id]);
      }
    } else if (body.type === "payment.failed" && order.status === "PENDING_PAYMENT") {
      publishedEvent = await recordStatus(client, order.id, "PAYMENT_FAILED", "payment", "Payment failed");
      await client.query("UPDATE products SET stock = stock + $1 WHERE sku = $2 AND stock <> -1", [
        order.quantity,
        order.sku
      ]);
      if (order.discount_code) {
        await client.query("UPDATE discount_codes SET uses_count = GREATEST(0, uses_count - 1) WHERE code = $1", [
          order.discount_code
        ]);
      }
    } else if (body.type === "payment.refunded" && order.status !== "REFUNDED") {
      publishedEvent = await recordStatus(client, order.id, "REFUNDED", "payment", "Refund confirmed by payment provider");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  if (publishedEvent) await publishOrderEvent({ ...publishedEvent, order_id: body.order_id });
}

async function quote(input, database = pool) {
  const productResult = await database.query(
    "SELECT sku, name, price_satang, stock, max_per_order FROM products WHERE sku = $1 AND active = TRUE",
    [input.sku]
  );
  const product = productResult.rows[0];
  if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
  if (input.quantity > product.max_per_order) {
    throw new HttpError(400, "PER_ORDER_LIMIT", `Only ${product.max_per_order} item(s) are allowed per order`);
  }
  if (product.stock !== -1 && product.stock < input.quantity) {
    throw new HttpError(409, "OUT_OF_STOCK", "Not enough stock");
  }

  let discount = null;
  if (input.discountCode) {
    const result = await database.query(
      `SELECT * FROM discount_codes WHERE code = $1 AND active = TRUE
       AND (max_uses IS NULL OR uses_count < max_uses)`,
      [input.discountCode]
    );
    discount = result.rows[0];
    if (!discount) throw new HttpError(400, "VOUCHER_EXHAUSTED", "The discount code is invalid or fully used");
    if (BigInt(product.price_satang) * BigInt(input.quantity) < BigInt(discount.min_order_satang)) {
      throw new HttpError(400, "MINIMUM_ORDER_NOT_MET", "The order does not meet the discount minimum");
    }
  }

  return {
    product,
    ...calculateTotals([product.price_satang], [input.quantity], discount, input.paymentMethod)
  };
}

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "api" }));

app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    if (redis.status === "wait") await redis.connect();
    await redis.ping();
    return res.json({ status: "ok" });
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "readiness_check_failed", error: error.message }));
    return problem(res, 503, "DEPENDENCY_UNAVAILABLE", "A required service is unavailable");
  }
});

app.get("/api/v1/products", async (_req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT sku, name, price_satang, stock, max_per_order FROM products WHERE active = TRUE ORDER BY sku"
    );
    return res.json(result.rows.map((row) => ({
      ...row,
      price_satang: Number(row.price_satang)
    })));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/products/:slug", async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT sku, name, price_satang, stock, max_per_order FROM products WHERE sku = $1 AND active = TRUE",
      [req.params.slug.toUpperCase()]
    );
    if (!result.rows[0]) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
    return res.json({ ...result.rows[0], price_satang: Number(result.rows[0].price_satang) });
  } catch (error) {
    return next(error);
  }
});

app.post(["/api/v1/checkout/quote", "/api/v1/orders/quote"], async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const input = parseOrderInput({
      ...body,
      email: body.email || "quote@example.com",
      playerId: body.playerId || "quote"
    });
    const result = await quote(input);
    return res.json({
      sku: result.product.sku,
      productName: result.product.name,
      quantity: input.quantity,
      subtotalSatang: result.subtotalSatang,
      discountSatang: result.discountSatang,
      feeSatang: result.feeSatang,
      vatSatang: result.vatSatang,
      totalSatang: result.totalSatang
    });
  } catch (error) {
    return next(error);
  }
});

app.post(["/api/v1/orders", "/api/v1/checkout"], async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const key = req.get("Idempotency-Key");
  if (!key || key.length > 200) {
    return problem(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid Idempotency-Key header");
  }
  let input;
  try {
    input = parseOrderInput(req.body);
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const client = await pool.connect();
    let responseBody;
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        [key, requestHash]
      );
      const keyResult = await client.query("SELECT * FROM idempotency_keys WHERE key = $1 FOR UPDATE", [key]);
      const existing = keyResult.rows[0];
      if (existing.request_hash !== requestHash) {
        throw new HttpError(422, "IDEMPOTENCY_KEY_REUSED", "This key was already used with a different request");
      }
      if (existing.response_body) {
        responseBody = existing.response_body;
      } else {
        const result = await quote(input, client);
        const product = await client.query(
          "SELECT stock FROM products WHERE sku = $1 FOR UPDATE",
          [input.sku]
        );
        if (product.rows[0].stock !== -1 && product.rows[0].stock < input.quantity) {
          throw new HttpError(409, "OUT_OF_STOCK", "Not enough stock");
        }
        if (input.discountCode) {
          const codeResult = await client.query(
            "SELECT * FROM discount_codes WHERE code = $1 AND active = TRUE FOR UPDATE",
            [input.discountCode]
          );
          const discount = codeResult.rows[0];
          if (!discount || (discount.max_uses !== null && discount.uses_count >= discount.max_uses)) {
            throw new HttpError(409, "VOUCHER_EXHAUSTED", "The discount code is fully used");
          }
          const priorUse = await client.query(
            `SELECT 1 FROM orders WHERE discount_code = $1 AND email = $2
             AND status NOT IN ('EXPIRED', 'PAYMENT_FAILED', 'FAILED', 'REFUNDED') LIMIT 1`,
            [input.discountCode, input.email]
          );
          if (priorUse.rowCount) throw new HttpError(409, "VOUCHER_ALREADY_USED", "This email already used the discount");
          await client.query("UPDATE discount_codes SET uses_count = uses_count + 1 WHERE code = $1", [input.discountCode]);
        }
        await client.query(
          "UPDATE products SET stock = stock - $1 WHERE sku = $2 AND stock <> -1",
          [input.quantity, input.sku]
        );
        const id = newOrderId();
        const inserted = await client.query(
          `INSERT INTO orders
            (id, email, player_id, sku, product_name, unit_price_satang, quantity,
             subtotal_satang, discount_satang, fee_satang, vat_satang, total_satang,
             discount_code, payment_method, status, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING_PAYMENT',
             NOW() + ($15 * INTERVAL '1 second')) RETURNING *`,
          [
            id, input.email, input.playerId, result.product.sku, result.product.name,
            result.product.price_satang, input.quantity, result.subtotalSatang,
            result.discountSatang, result.feeSatang, result.vatSatang, result.totalSatang,
            input.discountCode, input.paymentMethod, orderTtlSeconds
          ]
        );
        await client.query(
          "INSERT INTO order_events (order_id, status, actor, reason) VALUES ($1, 'PENDING_PAYMENT', 'customer', 'Order created')",
          [id]
        );
        responseBody = { ...formatOrder(inserted.rows[0]), trackingToken: signTrackToken(id, input.email) };
        await client.query(
          "UPDATE idempotency_keys SET status_code = 201, response_body = $2 WHERE key = $1",
          [key, JSON.stringify(responseBody)]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.status(201).json(responseBody);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/webhooks/payment", async (req, res, next) => {
  try {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) throw new HttpError(400, "INVALID_WEBHOOK", "Expected a JSON request body");
    const header = req.get("X-IBM-Signature") || "";
    const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header);
    if (!match) throw new HttpError(401, "INVALID_SIGNATURE", "Webhook signature is invalid");
    const timestamp = Number(match[1]);
    if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
      throw new HttpError(401, "EXPIRED_SIGNATURE", "Webhook signature has expired");
    }
    const expected = crypto.createHmac("sha256", paymentSecret)
      .update(`${match[1]}.${raw.toString("utf8")}`).digest();
    const actual = Buffer.from(match[2], "hex");
    if (!crypto.timingSafeEqual(expected, actual)) {
      throw new HttpError(401, "INVALID_SIGNATURE", "Webhook signature is invalid");
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "INVALID_JSON", "Webhook body is not valid JSON");
    }
    await applyWebhook(body);
    return res.status(200).json({ received: true });
  } catch (error) {
    return next(error);
  }
});

async function checkLimit(key, limit, seconds) {
  if (redis.status === "wait") await redis.connect();
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, seconds);
  if (count > limit) {
    const ttl = Math.max(1, await redis.ttl(key));
    throw new HttpError(429, "RATE_LIMITED", "Too many attempts; try again later", ttl);
  }
}

function requireSameOrigin(req) {
  const origin = req.get("Origin")?.replace(/\/$/, "");
  if (!origin || !allowedOrigins.has(origin)) {
    throw new HttpError(403, "ORIGIN_NOT_ALLOWED", "This request origin is not allowed");
  }
}

async function authenticate(req, res, next) {
  try {
    const token = cookieValue(req.get("Cookie"), sessionCookieName);
    if (!token || token.length > 200) {
      throw new HttpError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue");
    }
    const result = await pool.query(
      `SELECT u.id, u.email, u.role, s.token_hash
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
      [hashSessionToken(token)]
    );
    if (!result.rows[0]) {
      throw new HttpError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue");
    }
    req.auth = result.rows[0];
    if (req.auth.role === "admin" && !configuredAdminEmails.has(req.auth.email)) {
      await pool.query("UPDATE auth_users SET role = 'customer', updated_at = NOW() WHERE id = $1", [
        req.auth.id
      ]);
      req.auth.role = "customer";
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.auth.role !== "admin") {
    return problem(res, 403, "ADMIN_REQUIRED", "Administrator access is required");
  }
  return next();
}

function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "true";
  res.cookie(sessionCookieName, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: sessionLifetimeSeconds * 1000
  });
}

function clearSessionCookie(res) {
  res.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "strict",
    path: "/"
  });
}

app.post("/api/v1/auth/request-otp", async (req, res, next) => {
  let challengeId;
  try {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
    await checkLimit(`otp:ip:${req.ip}`, 10, 15 * 60);
    await checkLimit(`otp:email:${crypto.createHash("sha256").update(email).digest("hex")}`, 3, 15 * 60);
    const code = generateOtp();
    challengeId = crypto.randomUUID();
    await pool.query(
      `UPDATE otp_challenges SET consumed_at = NOW()
       WHERE email = $1 AND consumed_at IS NULL`,
      [email]
    );
    await pool.query(
      `INSERT INTO otp_challenges (id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')`,
      [challengeId, email, hashOtp(email, code, authSecret)]
    );
    try {
      await mailer.sendMail({
        from: process.env.MAIL_FROM || "InBlack Top-Up <no-reply@inblack.local>",
        to: email,
        subject: "Your InBlack Top-Up sign-in code",
        text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`
      });
    } catch (error) {
      await pool.query("UPDATE otp_challenges SET consumed_at = NOW() WHERE id = $1", [challengeId]);
      console.error(JSON.stringify({ level: "error", message: "otp_email_delivery_failed", error: error.message }));
      throw new HttpError(503, "EMAIL_UNAVAILABLE", "The sign-in email could not be sent; try again later");
    }
    res.set("Cache-Control", "no-store");
    return res.status(202).json({ status: "accepted", expiresInSeconds: 600 });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/auth/verify-otp", async (req, res, next) => {
  const email = normalizeEmail(req.body?.email);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!validEmail(email) || !/^\d{6}$/.test(code)) {
    return problem(res, 400, "INVALID_OTP", "Enter a valid email address and six-digit code");
  }
  let client;
  let token;
  let user;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const challengeResult = await client.query(
      `SELECT id, code_hash, attempts FROM otp_challenges
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW() AND attempts < 5
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || !safeEqualHex(challenge.code_hash, hashOtp(email, code, authSecret))) {
      if (challenge) {
        await client.query("UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1", [challenge.id]);
      }
      await client.query("COMMIT");
      throw new HttpError(401, "INVALID_OTP", "The sign-in code is invalid or expired");
    }
    await client.query("UPDATE otp_challenges SET consumed_at = NOW() WHERE id = $1", [challenge.id]);
    const userResult = await client.query("SELECT id, email, role FROM auth_users WHERE email = $1 FOR UPDATE", [email]);
    user = userResult.rows[0];
    const role = configuredAdminEmails.has(email) ? "admin" : "customer";
    if (!user) {
      user = (await client.query(
        `INSERT INTO auth_users (id, email, role) VALUES ($1, $2, $3)
         RETURNING id, email, role`,
        [crypto.randomUUID(), email, role]
      )).rows[0];
    } else if (role !== user.role) {
      user = (await client.query(
        `UPDATE auth_users SET role = $2, updated_at = NOW() WHERE id = $1
         RETURNING id, email, role`,
        [user.id, role]
      )).rows[0];
    }
    token = crypto.randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 second'))`,
      [hashSessionToken(token), user.id, sessionLifetimeSeconds]
    );
    await client.query("COMMIT");
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    if (client) client.release();
  }
  res.set("Cache-Control", "no-store");
  setSessionCookie(res, token);
  return res.json({ user: { id: user.id, email: user.email, role: user.role } });
});

app.get("/api/v1/auth/me", authenticate, (req, res) => {
  res.set("Cache-Control", "no-store");
  return res.json({ user: { id: req.auth.id, email: req.auth.email, role: req.auth.role } });
});

app.post("/api/v1/auth/logout", authenticate, async (req, res, next) => {
  try {
    requireSameOrigin(req);
    await pool.query("UPDATE auth_sessions SET revoked_at = NOW() WHERE token_hash = $1", [
      req.auth.token_hash
    ]);
    clearSessionCookie(res);
    return res.status(204).end();
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/admin/products", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT sku, name, price_satang, stock, max_per_order, active FROM products ORDER BY sku"
    );
    return res.json(result.rows.map((row) => ({ ...row, price_satang: Number(row.price_satang) })));
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/admin/products/:sku", authenticate, requireAdmin, async (req, res, next) => {
  const { priceSatang, stock, active } = req.body || {};
  if ((priceSatang !== undefined && (!Number.isSafeInteger(priceSatang) || priceSatang < 0)) ||
      (stock !== undefined && (!Number.isInteger(stock) || stock < -1)) ||
      (active !== undefined && typeof active !== "boolean") ||
      (priceSatang === undefined && stock === undefined && active === undefined)) {
    return problem(res, 400, "INVALID_PRODUCT_UPDATE", "Provide a valid price, stock, or active value");
  }
  try {
    requireSameOrigin(req);
    const client = await pool.connect();
    let updated;
    try {
      await client.query("BEGIN");
      const current = await client.query("SELECT * FROM products WHERE sku = $1 FOR UPDATE", [
        req.params.sku.toUpperCase()
      ]);
      if (!current.rows[0]) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
      const row = current.rows[0];
      updated = (await client.query(
        `UPDATE products SET price_satang = $2, stock = $3, active = $4
         WHERE sku = $1
         RETURNING sku, name, price_satang, stock, max_per_order, active`,
        [
          row.sku,
          priceSatang ?? Number(row.price_satang),
          stock ?? row.stock,
          active ?? row.active
        ]
      )).rows[0];
      await client.query(
        `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'product.update', 'product', $2, $3)`,
        [req.auth.id, row.sku, JSON.stringify({ priceSatang, stock, active })]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.json({ ...updated, price_satang: Number(updated.price_satang) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/admin/orders", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const result = await pool.query(
      `SELECT * FROM orders WHERE ($1::text IS NULL OR status = $1)
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [status]
    );
    return res.json(result.rows.map(formatOrder));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/admin/orders/:id/refund", authenticate, requireAdmin, async (req, res, next) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300) {
    return problem(res, 400, "INVALID_REFUND_REASON", "Provide a refund reason between 3 and 300 characters");
  }
  try {
    requireSameOrigin(req);
    if (!validOrderId(req.params.id)) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
      const order = result.rows[0];
      if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
      if (!["PAID", "IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "NEEDS_REVIEW"].includes(order.status)) {
        throw new HttpError(409, "ORDER_NOT_REFUNDABLE", "This order cannot be refunded in its current state");
      }
      const existing = await client.query("SELECT status FROM refund_jobs WHERE order_id = $1 FOR UPDATE", [order.id]);
      if (existing.rows[0] && !["dead", "retry"].includes(existing.rows[0].status)) {
        throw new HttpError(409, "REFUND_ALREADY_REQUESTED", "A refund is already pending or completed");
      }
      if (existing.rows[0]) {
        await client.query(
          `UPDATE refund_jobs SET amount_satang = $2, status = 'queued', attempts = 0,
           run_after = NOW(), requested_by = $3, reason = $4 WHERE order_id = $1`,
          [order.id, order.total_satang, req.auth.id, reason]
        );
      } else {
        await client.query(
          `INSERT INTO refund_jobs (order_id, amount_satang, requested_by, reason)
           VALUES ($1, $2, $3, $4)`,
          [order.id, order.total_satang, req.auth.id, reason]
        );
      }
      await client.query(
        `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'order.refund.request', 'order', $2, $3)`,
        [req.auth.id, order.id, JSON.stringify({ amountSatang: Number(order.total_satang), reason })]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.status(202).json({ status: "refund_queued", orderId: req.params.id });
  } catch (error) {
    return next(error);
  }
});

app.post(
  "/api/v1/admin/reconciliation/import",
  authenticate,
  requireAdmin,
  express.text({ type: ["text/csv", "application/csv"], limit: "2mb" }),
  async (req, res, next) => {
    let records;
    try {
      requireSameOrigin(req);
      records = parseCsv(req.body);
    } catch (error) {
      return next(error instanceof HttpError
        ? error
        : new HttpError(400, "INVALID_SETTLEMENT_CSV", error.message));
    }
    try {
      const batchId = crypto.randomUUID();
      const fileName = (req.get("X-File-Name") || "settlement.csv").replace(/[^\w.-]/g, "_").slice(0, 120);
      const client = await pool.connect();
      let matchedCount = 0;
      let mismatchCount = 0;
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO reconciliation_batches (id, uploaded_by, file_name, row_count) VALUES ($1, $2, $3, $4)",
          [batchId, req.auth.id, fileName, records.length]
        );
        const [internalResult, orderResult] = await Promise.all([
          client.query(
            "SELECT event_id, order_id, event_type, payload FROM payment_webhook_events WHERE event_id = ANY($1::text[])",
            [records.map((record) => record.eventId)]
          ),
          client.query("SELECT id FROM orders WHERE id = ANY($1::text[])", [records.map((record) => record.orderId)])
        ]);
        const internalEvents = new Map(internalResult.rows.map((event) => [event.event_id, event]));
        const orderIds = new Set(orderResult.rows.map((order) => order.id));
        const items = records.map((record) => {
          const internal = internalEvents.get(record.eventId) || null;
          const comparison = compareSettlement(record, internal, orderIds.has(record.orderId));
          if (comparison.status === "matched") matchedCount += 1;
          else mismatchCount += 1;
          return {
            provider_event_id: record.eventId,
            order_id: record.orderId,
            amount_satang: record.amountSatang,
            currency: record.currency,
            event_type: record.type,
            status: comparison.status,
            detail: comparison.detail,
            internal_event_id: internal?.event_id || null
          };
        });
        await client.query(
          `INSERT INTO reconciliation_items
           (batch_id, provider_event_id, order_id, amount_satang, currency, event_type, status, detail, internal_event_id)
           SELECT $1, row.provider_event_id, row.order_id, row.amount_satang, row.currency,
             row.event_type, row.status, row.detail, row.internal_event_id
           FROM jsonb_to_recordset($2::jsonb) AS row(
             provider_event_id text, order_id text, amount_satang bigint, currency text,
             event_type text, status text, detail text, internal_event_id text
           )`,
          [batchId, JSON.stringify(items)]
        );
        const eventIds = records.map((record) => record.eventId);
        const missing = await client.query(
          `SELECT event_id, order_id, event_type, payload FROM payment_webhook_events
           WHERE event_type IN ('payment.succeeded', 'payment.refunded')
             AND NOT (event_id = ANY($1::text[]))`,
          [eventIds]
        );
        const missingItems = missing.rows.map((event) => ({
          provider_event_id: `missing-in-provider:${event.event_id}`,
          order_id: event.order_id,
          amount_satang: Number(event.payload.amount_satang),
          currency: event.payload.currency,
          event_type: event.event_type,
          status: "missing_provider_event",
          detail: "Internal payment event is absent from the provider settlement",
          internal_event_id: event.event_id
        }));
        if (missingItems.length) {
          await client.query(
            `INSERT INTO reconciliation_items
             (batch_id, provider_event_id, order_id, amount_satang, currency, event_type, status, detail, internal_event_id)
             SELECT $1, row.provider_event_id, row.order_id, row.amount_satang, row.currency,
               row.event_type, row.status, row.detail, row.internal_event_id
             FROM jsonb_to_recordset($2::jsonb) AS row(
               provider_event_id text, order_id text, amount_satang bigint, currency text,
               event_type text, status text, detail text, internal_event_id text
             )`,
            [batchId, JSON.stringify(missingItems)]
          );
          mismatchCount += missingItems.length;
        }
        const status = mismatchCount ? "completed_with_mismatches" : "completed";
        await client.query(
          `UPDATE reconciliation_batches SET matched_count = $2, mismatch_count = $3, status = $4
           WHERE id = $1`,
          [batchId, matchedCount, mismatchCount, status]
        );
        await client.query(
          `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'reconciliation.import', 'reconciliation_batch', $2, $3)`,
          [req.auth.id, batchId, JSON.stringify({ fileName, rowCount: records.length, matchedCount, mismatchCount })]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.status(201).json({
        id: batchId,
        file_name: fileName,
        row_count: records.length,
        matched_count: matchedCount,
        mismatch_count: mismatchCount,
        status: mismatchCount ? "completed_with_mismatches" : "completed"
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.get("/api/v1/admin/reconciliation", authenticate, requireAdmin, async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, file_name, row_count, matched_count, mismatch_count, status, created_at
       FROM reconciliation_batches ORDER BY created_at DESC LIMIT 50`
    );
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/admin/reconciliation/:id", authenticate, requireAdmin, async (req, res, next) => {
  try {
    const batch = await pool.query("SELECT * FROM reconciliation_batches WHERE id = $1", [req.params.id]);
    if (!batch.rows[0]) throw new HttpError(404, "RECONCILIATION_NOT_FOUND", "Reconciliation batch not found");
    const items = await pool.query(
      `SELECT provider_event_id, order_id, amount_satang, currency, event_type, status, detail
       FROM reconciliation_items WHERE batch_id = $1 ORDER BY id`,
      [req.params.id]
    );
    return res.json({ ...batch.rows[0], items: items.rows });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/orders/track", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const id = typeof req.body.order_id === "string" ? req.body.order_id.trim() : "";
    const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    await checkLimit(`track:ip:${req.ip}`, 10, 60);
    if (id) await checkLimit(`track:order:${id}`, 5, 60);
    const result = validOrderId(id)
      ? await pool.query(
        "SELECT * FROM orders WHERE id = $1 AND lower(email) = $2",
        [id, email]
      )
      : { rows: [] };
    await new Promise((resolve) => setTimeout(resolve, 75));
    if (!result.rows[0]) return problem(res, 404, "ORDER_NOT_FOUND", "Order not found or email does not match");
    return res.json({
      order: formatOrder(result.rows[0]),
      trackingToken: signTrackToken(id, email)
    });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/orders/:id/events", async (req, res, next) => {
  const id = req.params.id;
  const token = (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!validOrderId(id) || !verifyTrackToken(token, id)) {
    return problem(res, 404, "ORDER_NOT_FOUND", "Order not found");
  }
  let subscriber;
  try {
    subscriber = new Redis(process.env.REDIS_URL || "redis://redis:6379", {
      maxRetriesPerRequest: 1,
      retryStrategy: () => null
    });
    await subscriber.subscribe(`order:${id}`);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.flushHeaders();
    const requestedLastId = Number(req.get("Last-Event-ID") || req.query.lastEventId || 0);
    let lastId = Number.isSafeInteger(requestedLastId) && requestedLastId >= 0 ? requestedLastId : 0;
    const pendingEvents = [];
    let replaying = true;
    const sendEvent = (event) => {
      if (Number(event.id) <= lastId) return;
      lastId = Number(event.id);
      res.write(`id: ${lastId}\nevent: status\ndata: ${JSON.stringify(event)}\n\n`);
    };
    subscriber.on("message", (_channel, message) => {
      const event = JSON.parse(message);
      if (replaying) pendingEvents.push(event);
      else sendEvent(event);
    });
    const history = await pool.query(
      "SELECT id, order_id, status, actor, reason, created_at FROM order_events WHERE order_id = $1 AND id > $2 ORDER BY id",
      [id, lastId]
    );
    for (const event of history.rows) sendEvent(event);
    replaying = false;
    pendingEvents.sort((left, right) => Number(left.id) - Number(right.id)).forEach(sendEvent);
    const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      subscriber.quit().catch(() => {});
    });
  } catch (error) {
    if (subscriber) subscriber.quit().catch(() => {});
    if (res.headersSent) return res.end();
    return next(error);
  }
});

app.get("/api/v1/orders/:id", (_req, res) =>
  problem(res, 404, "ORDER_NOT_FOUND", "Order not found")
);

app.use((error, req, res, _next) => {
  if (error instanceof HttpError) {
    if (error.retryAfter) res.set("Retry-After", String(error.retryAfter));
    return problem(res, error.status, error.code, error.message);
  }
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) {
    return problem(res, error.status, "INVALID_REQUEST", error.status === 413
      ? "The request body is too large"
      : "The request is invalid");
  }
  console.error(JSON.stringify({
    level: "error",
    request_id: req.requestId,
    message: "request_failed",
    error: error.message
  }));
  return problem(res, 500, "INTERNAL_SERVER_ERROR", "An unexpected error occurred");
});

const server = app.listen(Number(process.env.PORT || 3001), "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "api_started", port: process.env.PORT || 3001 }));
});

async function shutdown() {
  server.close();
  await Promise.all([pool.end(), redis.quit().catch(() => {})]);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
