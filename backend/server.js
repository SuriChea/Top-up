require("./tracing");

const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const nodemailer = require("nodemailer");
const { trace } = require("@opentelemetry/api");
const { Pool } = require("pg");
const Redis = require("ioredis");
const { calculateTotals, canTransitionOrder, newOrderId, validOrderId } = require("./domain");
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
const configuredRoleEmails = new Map([
  ...[...configuredAdminEmails].map((email) => [email, "admin"]),
  ...["VIEWER_EMAILS", "SUPPORT_EMAILS", "FINANCE_EMAILS", "SUPERADMIN_EMAILS"].flatMap((key) =>
    (process.env[key] || "").split(",").map(normalizeEmail).filter(Boolean).map((email) => [
      email,
      key.replace("_EMAILS", "").toLowerCase()
    ]))
]);
const staffRoles = new Set(["admin", "viewer", "support", "finance", "superadmin"]);
const rolePermissions = {
  viewer: new Set(["orders:read", "dashboard:read"]),
  support: new Set(["orders:read", "dashboard:read", "pii:read", "fulfillment:retry"]),
  finance: new Set(["orders:read", "dashboard:read", "pii:read", "refund:write", "reconciliation:write"]),
  superadmin: new Set([
    "orders:read", "dashboard:read", "pii:read", "fulfillment:retry",
    "refund:write", "reconciliation:write", "products:write", "users:write", "audit:read"
  ]),
  admin: new Set([
    "orders:read", "dashboard:read", "pii:read", "fulfillment:retry",
    "refund:write", "reconciliation:write", "products:write", "users:write", "audit:read"
  ])
};
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
  const suppliedId = req.get("x-request-id");
  const requestId = suppliedId && /^[\w.-]{1,128}$/.test(suppliedId) ? suppliedId : crypto.randomUUID();
  req.requestId = requestId;
  res.locals.requestId = requestId;
  res.set("x-request-id", requestId);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (process.env.COOKIE_SECURE === "true") {
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use("/api/v1/webhooks/payment", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));
app.use((req, _res, next) => {
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const hasSessionCookie = req.get("Cookie")?.split(";").some((cookie) =>
    cookie.trim().startsWith(`${sessionCookieName}=`));
  if (mutating && hasSessionCookie) {
    try {
      requireSameOrigin(req);
    } catch (error) {
      return next(error);
    }
  }
  return next();
});

const requestMetrics = { count: 0, durationSeconds: 0, buckets: new Map() };
const latencyBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
function activeTraceId() {
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  return traceId && traceId !== "00000000000000000000000000000000" ? traceId : null;
}

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.once("finish", () => {
    const duration = Number(process.hrtime.bigint() - startedAt) / 1e9;
    requestMetrics.count += 1;
    requestMetrics.durationSeconds += duration;
    for (const bound of latencyBuckets) {
      if (duration <= bound) requestMetrics.buckets.set(bound, (requestMetrics.buckets.get(bound) || 0) + 1);
    }
    console.log(JSON.stringify({
      level: "info",
      message: "http_request",
      request_id: req.requestId,
      trace_id: activeTraceId(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Math.round(duration * 1000)
    }));
  });
  next();
});

function problem(res, status, code, detail) {
  return res.status(status).type("application/problem+json").json({
    type: "about:blank",
    title: code.replaceAll("_", " "),
    status,
    code,
    detail,
    request_id: res.locals.requestId
  });
}

function parseOrderInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "INVALID_REQUEST", "A JSON request body is required");
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const rawItems = Array.isArray(body.items)
    ? body.items
    : [{ sku: body.sku, quantity: body.quantity, playerId: body.playerId }];
  if (rawItems.length < 1 || rawItems.length > 10) {
    throw new HttpError(400, "INVALID_ITEMS", "An order must contain between 1 and 10 product lines");
  }
  const itemsBySku = new Map();
  for (const item of rawItems) {
    const sku = typeof item?.sku === "string" ? item.sku.trim().toUpperCase() : "";
    const quantity = Number(item?.quantity);
    const playerId = typeof (item?.playerId ?? item?.gameUid ?? body.playerId) === "string"
      ? String(item.playerId ?? item.gameUid ?? body.playerId).trim()
      : "";
    if (!sku) throw new HttpError(400, "SKU_REQUIRED", "A product SKU is required");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw new HttpError(400, "INVALID_QUANTITY", "Quantity must be between 1 and 10");
    }
    if (!playerId || playerId.length > 100) {
      throw new HttpError(400, "INVALID_PLAYER_ID", "Enter a valid game UID");
    }
    const existing = itemsBySku.get(sku);
    if (existing && existing.playerId !== playerId) {
      throw new HttpError(400, "DUPLICATE_SKU_PLAYER_MISMATCH", "Each product may appear once per game UID");
    }
    itemsBySku.set(sku, { sku, quantity: (existing?.quantity || 0) + quantity, playerId });
  }
  const items = [...itemsBySku.values()];
  if (items.some((item) => item.quantity > 10)) {
    throw new HttpError(400, "INVALID_QUANTITY", "The total quantity of a product cannot exceed 10");
  }
  const { sku, quantity, playerId } = items[0];
  const discountCode = typeof body.discountCode === "string" && body.discountCode.trim()
    ? body.discountCode.trim().toUpperCase() : null;
  const paymentMethod = body.paymentMethod || "promptpay";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
  }
  if (!["promptpay", "truemoney", "card"].includes(paymentMethod)) {
    throw new HttpError(400, "INVALID_PAYMENT_METHOD", "Choose a supported payment method");
  }
  return { sku, quantity, email, playerId, items, discountCode, paymentMethod };
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
    refundedSatang: Number(row.refunded_satang || 0),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  };
}

function hasPermission(role, permission) {
  return rolePermissions[role]?.has(permission) === true;
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.auth.role, permission)) {
      return problem(res, 403, "FORBIDDEN", "You do not have permission to perform this action");
    }
    return next();
  };
}

function maskEmail(email) {
  const [name, domain] = String(email).split("@");
  return domain ? `${name.slice(0, 1)}***@${domain}` : "***";
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ createdAt: row.created_at, id: String(row.id) })).toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value.createdAt !== "string" || typeof value.id !== "string") throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
  }
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
  const current = await client.query("SELECT status FROM orders WHERE id = $1 FOR UPDATE", [id]);
  if (!current.rows[0]) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
  if (!canTransitionOrder(current.rows[0].status, status)) {
    throw new HttpError(
      409,
      "INVALID_TRANSITION",
      `The order cannot transition from ${current.rows[0].status} to ${status}`
    );
  }
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

    if (body.type !== "payment.refunded" && BigInt(body.amount_satang) !== BigInt(order.total_satang)) {
      publishedEvent = await recordStatus(client, order.id, "NEEDS_REVIEW", "payment", "Payment amount mismatch");
    } else if (body.type === "payment.succeeded") {
      if (order.status === "EXPIRED" || order.status === "PAYMENT_FAILED") {
        const itemsResult = await client.query(
          "SELECT sku, quantity FROM order_items WHERE order_id = $1 ORDER BY sku",
          [order.id]
        );
        const items = itemsResult.rows.length ? itemsResult.rows : [{ sku: order.sku, quantity: order.quantity }];
        await client.query(
          "SELECT sku FROM products WHERE sku = ANY($1::text[]) ORDER BY sku FOR UPDATE",
          [items.map((item) => item.sku)]
        );
        let purchaseLimitsAvailable = true;
        try {
          for (const item of items) {
            const product = await client.query(
              "SELECT sku, max_per_email, max_order_count FROM products WHERE sku = $1",
              [item.sku]
            );
            if (!product.rows[0]) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product no longer exists");
            await assertPurchaseLimits({
              email: normalizeEmail(order.email),
              sku: item.sku,
              quantity: item.quantity,
              items: [item]
            }, product.rows[0], client);
          }
        } catch (error) {
          if (!(error instanceof HttpError) ||
              !["PER_CUSTOMER_LIMIT", "PRODUCT_ORDER_LIMIT_REACHED"].includes(error.code)) {
            throw error;
          }
          purchaseLimitsAvailable = false;
        }
        let reservedItems = 0;
        if (purchaseLimitsAvailable) {
          for (const item of items) {
            const stock = await client.query(
              `UPDATE products SET stock = CASE WHEN stock = -1 THEN -1 ELSE stock - $1 END
               WHERE sku = $2 AND (stock = -1 OR stock >= $1)`,
              [item.quantity, item.sku]
            );
            if (!stock.rowCount) break;
            reservedItems += 1;
          }
        }
        let discountAvailable = true;
        if (reservedItems === items.length && purchaseLimitsAvailable && order.discount_code) {
          const discount = await client.query(
            "SELECT max_uses, uses_count, active FROM discount_codes WHERE code = $1 FOR UPDATE",
            [order.discount_code]
          );
          const priorUse = await client.query(
            `SELECT 1 FROM orders WHERE discount_code = $1 AND lower(email) = $2
             AND id <> $3 AND status NOT IN ('EXPIRED', 'PAYMENT_FAILED', 'REFUNDED')
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
        if (reservedItems !== items.length || !discountAvailable || !purchaseLimitsAvailable) {
          for (const item of items.slice(0, reservedItems)) {
            await client.query(
              "UPDATE products SET stock = CASE WHEN stock = -1 THEN -1 ELSE stock + $1 END WHERE sku = $2",
              [item.quantity, item.sku]
            );
          }
          await client.query(
            `INSERT INTO refund_jobs (order_id, amount_satang)
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
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
      const items = await client.query("SELECT sku, quantity FROM order_items WHERE order_id = $1", [order.id]);
      for (const item of items.rows.length ? items.rows : [{ sku: order.sku, quantity: order.quantity }]) {
        await client.query("UPDATE products SET stock = stock + $1 WHERE sku = $2 AND stock <> -1", [
          item.quantity,
          item.sku
        ]);
      }
      if (order.discount_code) {
        await client.query("UPDATE discount_codes SET uses_count = GREATEST(0, uses_count - 1) WHERE code = $1", [
          order.discount_code
        ]);
      }
    } else if (body.type === "payment.refunded") {
      const refundAmount = BigInt(body.amount_satang);
      const refundedAmount = BigInt(order.refunded_satang || 0);
      if (refundAmount <= 0n || refundedAmount + refundAmount > BigInt(order.total_satang)) {
        publishedEvent = await recordStatus(client, order.id, "NEEDS_REVIEW", "payment", "Refund amount exceeds remaining paid balance");
      } else {
        const newRefundedAmount = refundedAmount + refundAmount;
        await client.query("UPDATE orders SET refunded_satang = $2 WHERE id = $1", [order.id, newRefundedAmount.toString()]);
        const status = newRefundedAmount === BigInt(order.total_satang) ? "REFUNDED" : order.status;
        publishedEvent = await recordStatus(
          client,
          order.id,
          status,
          "payment",
          `Refund of ${refundAmount} satang confirmed by payment provider`
        );
      }
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

async function assertPurchaseLimits(input, product, database) {
  for (const item of input.items || [{ sku: input.sku, quantity: input.quantity }]) {
    const activeStatuses = "o.status NOT IN ('EXPIRED', 'PAYMENT_FAILED', 'REFUNDED')";
    const purchaseResult = await database.query(
      `SELECT COALESCE(SUM(oi.quantity), 0)::bigint AS quantity
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE oi.sku = $1 AND lower(o.email) = $2 AND ${activeStatuses}`,
      [item.sku, input.email]
    );
    const purchasedQuantity = BigInt(purchaseResult.rows[0].quantity);
    if (product.sku === item.sku && product.max_per_email !== null &&
        purchasedQuantity + BigInt(item.quantity) > BigInt(product.max_per_email)) {
      throw new HttpError(
        409,
        "PER_CUSTOMER_LIMIT",
        `This product is limited to ${product.max_per_email} item(s) per account`
      );
    }
    if (product.sku === item.sku && product.max_order_count !== null) {
      const orderCount = await database.query(
        `SELECT COUNT(DISTINCT o.id)::integer AS count
         FROM orders o JOIN order_items oi ON oi.order_id = o.id
         WHERE oi.sku = $1 AND o.status NOT IN ('EXPIRED', 'PAYMENT_FAILED', 'REFUNDED')`,
        [item.sku]
      );
      if (orderCount.rows[0].count >= product.max_order_count) {
        throw new HttpError(409, "PRODUCT_ORDER_LIMIT_REACHED", "All limited-edition orders have been claimed");
      }
    }
  }
}

async function quote(input, database = pool) {
  const items = input.items || [{ sku: input.sku, quantity: input.quantity, playerId: input.playerId }];
  const productResult = await database.query(
    `SELECT sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count
     FROM products WHERE sku = ANY($1::text[]) AND active = TRUE ORDER BY sku`,
    [items.map((item) => item.sku)]
  );
  const productsBySku = new Map(productResult.rows.map((product) => [product.sku, product]));
  const products = items.map((item) => {
    const product = productsBySku.get(item.sku);
    if (!product) throw new HttpError(404, "PRODUCT_NOT_FOUND", `Product ${item.sku} not found`);
    if (item.quantity > product.max_per_order) {
      throw new HttpError(400, "PER_ORDER_LIMIT", `Only ${product.max_per_order} item(s) of ${item.sku} are allowed per order`);
    }
    if (product.stock !== -1 && product.stock < item.quantity) {
      throw new HttpError(409, "OUT_OF_STOCK", `Not enough stock for ${item.sku}`);
    }
    return { ...item, product };
  });
  for (const item of products) {
    await assertPurchaseLimits({ ...input, sku: item.sku, quantity: item.quantity, items: [item] }, item.product, database);
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
    const subtotal = products.reduce((sum, item) =>
      sum + BigInt(item.product.price_satang) * BigInt(item.quantity), 0n);
    if (subtotal < BigInt(discount.min_order_satang)) {
      throw new HttpError(400, "MINIMUM_ORDER_NOT_MET", "The order does not meet the discount minimum");
    }
  }

  const totals = calculateTotals(
    products.map((item) => item.product.price_satang),
    products.map((item) => item.quantity),
    discount,
    input.paymentMethod
  );
  return {
    product: products[0].product,
    products,
    ...totals
  };
}

app.get("/healthz", (_req, res) => res.json({ status: "ok", service: "api" }));

app.get("/metrics", async (_req, res, next) => {
  try {
    const [orders, jobs] = await Promise.all([
      pool.query("SELECT status, COUNT(*)::bigint AS count FROM orders GROUP BY status"),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('queued', 'retry'))::bigint AS queue_depth,
           COUNT(*) FILTER (WHERE status = 'dead')::bigint AS dead_letter,
           COALESCE(SUM(attempts), 0)::bigint AS retries
         FROM fulfillment_jobs`
      )
    ]);
    const lines = [
      "# TYPE http_server_requests_total counter",
      `http_server_requests_total ${requestMetrics.count}`,
      "# TYPE http_server_request_duration_seconds histogram"
    ];
    for (const bound of latencyBuckets) {
      lines.push(`http_server_request_duration_seconds_bucket{le="${bound}"} ${requestMetrics.buckets.get(bound) || 0}`);
    }
    lines.push(`http_server_request_duration_seconds_bucket{le="+Inf"} ${requestMetrics.count}`);
    lines.push(`http_server_request_duration_seconds_sum ${requestMetrics.durationSeconds}`);
    lines.push(`http_server_request_duration_seconds_count ${requestMetrics.count}`);
    lines.push("# TYPE orders_total gauge");
    for (const row of orders.rows) {
      lines.push(`orders_total{status="${row.status}"} ${row.count}`);
    }
    lines.push(
      "# TYPE fulfillment_queue_depth gauge",
      `fulfillment_queue_depth ${jobs.rows[0].queue_depth}`,
      "# TYPE fulfillment_dead_letter_total gauge",
      `fulfillment_dead_letter_total ${jobs.rows[0].dead_letter}`,
      "# TYPE fulfillment_attempts_total counter",
      `fulfillment_attempts_total ${jobs.rows[0].retries}`
    );
    return res.type("text/plain; version=0.0.4; charset=utf-8").send(`${lines.join("\n")}\n`);
  } catch (error) {
    return next(error);
  }
});

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

app.post("/api/v1/_test/reset", async (req, res, next) => {
  if (process.env.APP_ENV !== "test") {
    return problem(res, 404, "NOT_FOUND", "Route not found");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`TRUNCATE TABLE
      email_outbox, refund_idempotency, mock_payment_refunds, refund_jobs, fulfillment_jobs,
      payment_webhook_events, reconciliation_items, reconciliation_batches,
      admin_audit_logs, refund_requests, otp_email_locks, otp_challenges,
      auth_sessions, auth_users, order_events, order_items, orders, idempotency_keys,
      mock_game_topups, discount_codes, products RESTART IDENTITY CASCADE`);
    await client.query(
      `INSERT INTO products (sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count)
       VALUES
         ('DIAMOND-1000', '1,000 Diamonds', 34900, -1, 10, NULL, NULL),
         ('DIAMOND-5000', '5,000 Diamonds', 159000, -1, 10, NULL, NULL),
         ('MONTHLY-PASS', 'Monthly Pass', 17900, -1, 1, 1, NULL),
         ('FLASH-SKIN-01', 'Limited Skin (Flash Sale)', 9900, 100, 2, 2, 100)`
    );
    await client.query(
      `INSERT INTO discount_codes
       (code, discount_type, discount_value, max_discount_satang, min_order_satang, max_uses)
       VALUES ('SAVE10', 'percent', 10, 5000, 20000, 10),
         ('FLAT20', 'fixed', 2000, NULL, 10000, NULL)`
    );
    for (const [email, role] of configuredRoleEmails) {
      await client.query(
        `INSERT INTO auth_users (id, email, role, role_source)
         VALUES ($1, $2, $3, 'env')`,
        [crypto.randomUUID(), email, role]
      );
    }
    await client.query("COMMIT");
    if (redis.status === "wait") await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "otp:*", "COUNT", 100);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
    cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "track:*", "COUNT", 100);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
    return res.json({ status: "reset" });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return next(error);
  } finally {
    client.release();
  }
});

app.get("/api/v1/products", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count
       FROM products WHERE active = TRUE ORDER BY sku`
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
      `SELECT sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count
       FROM products WHERE sku = $1 AND active = TRUE`,
      [req.params.slug.toUpperCase()]
    );
    if (!result.rows[0]) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
    return res.json({ ...result.rows[0], price_satang: Number(result.rows[0].price_satang) });
  } catch (error) {
    return next(error);
  }
});

app.post(["/api/v1/checkout/quote", "/api/v1/orders/quote"], authenticate, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
    const input = parseOrderInput({
      ...body,
      email: req.auth.email,
      playerId: body.playerId || "quote"
    });
    const result = await quote(input);
    return res.json({
      sku: result.product.sku,
      productName: result.product.name,
      quantity: input.quantity,
      items: result.products.map((item) => ({
        sku: item.product.sku,
        productName: item.product.name,
        quantity: item.quantity,
        unitPriceSatang: Number(item.product.price_satang)
      })),
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

app.post(["/api/v1/orders", "/api/v1/checkout"], authenticate, async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  const key = req.get("Idempotency-Key");
  if (!key || key.length > 200) {
    return problem(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid Idempotency-Key header");
  }
  let input;
  try {
    requireSameOrigin(req);
    input = parseOrderInput(req.body);
    if (input.email !== req.auth.email) {
      throw new HttpError(403, "CHECKOUT_EMAIL_MISMATCH", "Orders must use the email address signed in to this account");
    }
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const client = await pool.connect();
    let responseBody;
    let responseRaw;
    let replayed = false;
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM idempotency_keys WHERE expires_at <= NOW()");
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
        responseRaw = existing.response_body_text || JSON.stringify(existing.response_body);
        replayed = true;
      } else {
        const lockedProducts = await client.query(
          `SELECT sku, stock, max_per_email, max_order_count FROM products
           WHERE sku = ANY($1::text[]) ORDER BY sku FOR UPDATE`,
          [input.items.map((item) => item.sku)]
        );
        if (lockedProducts.rowCount !== input.items.length) {
          throw new HttpError(404, "PRODUCT_NOT_FOUND", "One or more products were not found");
        }
        const result = await quote(input, client);
        const product = await client.query(
          "SELECT stock, max_per_email, max_order_count FROM products WHERE sku = $1",
          [input.sku]
        );
        if (!product.rows[0]) throw new HttpError(404, "PRODUCT_NOT_FOUND", "Product not found");
        if (product.rows[0].stock !== -1 && product.rows[0].stock < input.quantity) {
          throw new HttpError(409, "OUT_OF_STOCK", "Not enough stock");
        }
        for (const item of input.items) {
          const itemProduct = lockedProducts.rows.find((row) => row.sku === item.sku);
          if (itemProduct.stock !== -1 && itemProduct.stock < item.quantity) {
            throw new HttpError(409, "OUT_OF_STOCK", `Not enough stock for ${item.sku}`);
          }
          await assertPurchaseLimits({ ...input, ...item, items: [item] }, itemProduct, client);
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
            `SELECT 1 FROM orders WHERE discount_code = $1 AND lower(email) = $2
             AND status NOT IN ('EXPIRED', 'PAYMENT_FAILED', 'REFUNDED') LIMIT 1`,
            [input.discountCode, input.email]
          );
          if (priorUse.rowCount) throw new HttpError(409, "VOUCHER_ALREADY_USED", "This email already used the discount");
          await client.query("UPDATE discount_codes SET uses_count = uses_count + 1 WHERE code = $1", [input.discountCode]);
        }
        for (const item of input.items) {
          await client.query(
            "UPDATE products SET stock = stock - $1 WHERE sku = $2 AND stock <> -1",
            [item.quantity, item.sku]
          );
        }
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
        for (const item of result.products) {
          await client.query(
            `INSERT INTO order_items
             (order_id, sku, product_name, player_id, unit_price_satang, quantity, game_reference)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              id, item.product.sku, item.product.name, item.playerId,
              item.product.price_satang, item.quantity, `${id}:${item.product.sku}`
            ]
          );
        }
        await client.query(
          "INSERT INTO order_events (order_id, status, actor, reason) VALUES ($1, 'PENDING_PAYMENT', 'customer', 'Order created')",
          [id]
        );
        responseBody = {
          ...formatOrder(inserted.rows[0]),
          items: result.products.map((item) => ({
            sku: item.product.sku,
            productName: item.product.name,
            playerId: item.playerId,
            quantity: item.quantity,
            unitPriceSatang: Number(item.product.price_satang)
          })),
          trackingToken: signTrackToken(id, input.email)
        };
        await client.query(
          `UPDATE idempotency_keys
           SET status_code = 201, response_body = $2, response_body_text = $3,
             expires_at = NOW() + INTERVAL '24 hours'
           WHERE key = $1`,
          [key, JSON.stringify(responseBody), JSON.stringify(responseBody)]
        );
        responseRaw = JSON.stringify(responseBody);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (replayed) return res.status(201).type("application/json").send(responseRaw);
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
      `SELECT u.id, u.email, u.role, u.role_source, s.token_hash
       FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
      [hashSessionToken(token)]
    );
    if (!result.rows[0]) {
      throw new HttpError(401, "AUTHENTICATION_REQUIRED", "Sign in to continue");
    }
    req.auth = result.rows[0];
    const configuredRole = configuredRoleEmails.get(normalizeEmail(req.auth.email));
    const expectedRole = configuredRole || (req.auth.role_source === "env" ? "customer" : req.auth.role);
    if (req.auth.role !== expectedRole || (configuredRole && req.auth.role_source !== "env")) {
      await pool.query(
        "UPDATE auth_users SET role = $2, role_source = $3, updated_at = NOW() WHERE id = $1",
        [req.auth.id, expectedRole, configuredRole ? "env" : "manual"]
      );
      req.auth.role = expectedRole;
      req.auth.role_source = configuredRole ? "env" : "manual";
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdmin(req, res, next) {
  if (!staffRoles.has(req.auth.role)) {
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

app.post(["/api/v1/auth/request-otp", "/api/v1/auth/otp/request"], async (req, res, next) => {
  let challengeId;
  try {
    const email = normalizeEmail(req.body?.email);
    if (!validEmail(email)) throw new HttpError(400, "INVALID_EMAIL", "Enter a valid email address");
    await checkLimit(`otp:ip:${req.ip}`, 10, 15 * 60);
    await checkLimit(`otp:email:${crypto.createHash("sha256").update(email).digest("hex")}`, 3, 15 * 60);
    const lock = await pool.query(
      "SELECT locked_until FROM otp_email_locks WHERE email = $1 AND locked_until > NOW()",
      [email]
    );
    if (lock.rowCount) {
      const retryAfter = Math.max(1, Math.ceil((new Date(lock.rows[0].locked_until).getTime() - Date.now()) / 1000));
      throw new HttpError(429, "OTP_TEMPORARILY_LOCKED", "Too many invalid codes; request a new code later", retryAfter);
    }
    const code = generateOtp();
    challengeId = crypto.randomUUID();
    await pool.query(
      `UPDATE otp_challenges SET consumed_at = NOW()
       WHERE email = $1 AND consumed_at IS NULL`,
      [email]
    );
    await pool.query(
      `INSERT INTO otp_challenges (id, email, code_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '5 minutes')`,
      [challengeId, email, hashOtp(email, code, authSecret)]
    );
    try {
      await mailer.sendMail({
        from: process.env.MAIL_FROM || "InBlack Top-Up <no-reply@inblack.local>",
        to: email,
        subject: "Your InBlack Top-Up sign-in code",
        text: `Your sign-in code is ${code}. It expires in 5 minutes. If you did not request it, ignore this email.`
      });
    } catch (error) {
      await pool.query("UPDATE otp_challenges SET consumed_at = NOW() WHERE id = $1", [challengeId]);
      console.error(JSON.stringify({ level: "error", message: "otp_email_delivery_failed", error: error.message }));
      throw new HttpError(503, "EMAIL_UNAVAILABLE", "The sign-in email could not be sent; try again later");
    }
    res.set("Cache-Control", "no-store");
    return res.status(202).json({ status: "accepted", expiresInSeconds: 300 });
  } catch (error) {
    return next(error);
  }
});

app.post(["/api/v1/auth/verify-otp", "/api/v1/auth/otp/verify"], async (req, res, next) => {
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
    await client.query(
      "INSERT INTO otp_email_locks (email) VALUES ($1) ON CONFLICT (email) DO NOTHING",
      [email]
    );
    const lockResult = await client.query(
      "SELECT failed_attempts, locked_until FROM otp_email_locks WHERE email = $1 FOR UPDATE",
      [email]
    );
    if (lockResult.rows[0].locked_until && new Date(lockResult.rows[0].locked_until) > new Date()) {
      const retryAfter = Math.max(1, Math.ceil((new Date(lockResult.rows[0].locked_until).getTime() - Date.now()) / 1000));
      await client.query("COMMIT");
      throw new HttpError(429, "OTP_TEMPORARILY_LOCKED", "Too many invalid codes; try again later", retryAfter);
    }
    const challengeResult = await client.query(
      `SELECT id, code_hash, attempts FROM otp_challenges
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > NOW() AND attempts < 5
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email]
    );
    const challenge = challengeResult.rows[0];
    if (!challenge || !safeEqualHex(challenge.code_hash, hashOtp(email, code, authSecret))) {
      const failedAttempts = Number(lockResult.rows[0].failed_attempts) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await client.query(
        `UPDATE otp_email_locks SET failed_attempts = $2, locked_until = $3, updated_at = NOW()
         WHERE email = $1`,
        [email, failedAttempts >= 5 ? 0 : failedAttempts, lockedUntil]
      );
      if (challenge) {
        await client.query(
          "UPDATE otp_challenges SET attempts = attempts + 1, locked_until = $2 WHERE id = $1",
          [challenge.id, lockedUntil]
        );
      }
      await client.query("COMMIT");
      throw new HttpError(401, "INVALID_OTP", "The sign-in code is invalid or expired");
    }
    await client.query(
      "UPDATE otp_email_locks SET failed_attempts = 0, locked_until = NULL, updated_at = NOW() WHERE email = $1",
      [email]
    );
    await client.query("UPDATE otp_challenges SET consumed_at = NOW() WHERE id = $1", [challenge.id]);
    const userResult = await client.query("SELECT id, email, role, role_source FROM auth_users WHERE email = $1 FOR UPDATE", [email]);
    user = userResult.rows[0];
    const configuredRole = configuredRoleEmails.get(email);
    const role = configuredRole || user?.role || "customer";
    if (!user) {
      user = (await client.query(
        `INSERT INTO auth_users (id, email, role, role_source) VALUES ($1, $2, $3, $4)
         RETURNING id, email, role, role_source`,
        [crypto.randomUUID(), email, role, configuredRole ? "env" : "manual"]
      )).rows[0];
    } else if (role !== user.role || (configuredRole && user.role_source !== "env")) {
      user = (await client.query(
        `UPDATE auth_users SET role = $2, role_source = $3, updated_at = NOW() WHERE id = $1
         RETURNING id, email, role, role_source`,
        [user.id, role, configuredRole ? "env" : "manual"]
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

app.get("/api/v1/account/orders", authenticate, async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const result = await pool.query(
      `SELECT o.*, r.status AS refund_request_status
       FROM orders o LEFT JOIN refund_requests r ON r.order_id = o.id
       WHERE lower(o.email) = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [req.auth.email]
    );
    const ids = result.rows.map((row) => row.id);
    const lines = ids.length
      ? await pool.query(
        "SELECT order_id, sku, product_name, quantity, unit_price_satang FROM order_items WHERE order_id = ANY($1::text[]) ORDER BY id",
        [ids]
      )
      : { rows: [] };
    const linesByOrder = new Map();
    for (const line of lines.rows) {
      const current = linesByOrder.get(line.order_id) || [];
      current.push({
        sku: line.sku,
        productName: line.product_name,
        quantity: line.quantity,
        unitPriceSatang: Number(line.unit_price_satang)
      });
      linesByOrder.set(line.order_id, current);
    }
    return res.json(result.rows.map((row) => ({
      ...formatOrder(row),
      items: linesByOrder.get(row.id) || [],
      refundRequestStatus: row.refund_request_status,
      refundedSatang: Number(row.refunded_satang || 0)
    })));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/account/orders/:id/refund-request", authenticate, async (req, res, next) => {
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
      const result = await client.query(
        "SELECT * FROM orders WHERE id = $1 AND lower(email) = $2 FOR UPDATE",
        [req.params.id, req.auth.email]
      );
      const order = result.rows[0];
      if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
      if (!["PAID", "IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "NEEDS_REVIEW"].includes(order.status)) {
        throw new HttpError(409, "ORDER_NOT_REFUNDABLE", "This order cannot be refunded in its current state");
      }
      const existing = await client.query("SELECT status FROM refund_requests WHERE order_id = $1 FOR UPDATE", [
        order.id
      ]);
      if (existing.rows[0] && existing.rows[0].status !== "rejected") {
        throw new HttpError(409, "REFUND_REQUEST_EXISTS", "A refund request already exists for this order");
      }
      if (existing.rows[0]) {
        await client.query(
          `UPDATE refund_requests SET requested_by = $2, reason = $3, status = 'pending',
           admin_note = NULL, updated_at = NOW() WHERE order_id = $1`,
          [order.id, req.auth.id, reason]
        );
      } else {
        await client.query(
          "INSERT INTO refund_requests (order_id, requested_by, reason) VALUES ($1, $2, $3)",
          [order.id, req.auth.id, reason]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.status(202).json({ status: "pending", orderId: req.params.id });
  } catch (error) {
    return next(error);
  }
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

app.get("/api/v1/admin/products", authenticate, requireAdmin, requirePermission("orders:read"), async (_req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT sku, name, price_satang, stock, max_per_order, active FROM products ORDER BY sku"
    );
    return res.json(result.rows.map((row) => ({ ...row, price_satang: Number(row.price_satang) })));
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/admin/products/:sku", authenticate, requireAdmin, requirePermission("products:write"), async (req, res, next) => {
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

app.post(
  "/api/v1/admin/products",
  authenticate,
  requireAdmin,
  requirePermission("products:write"),
  async (req, res, next) => {
    const body = req.body || {};
    const sku = typeof body.sku === "string" ? body.sku.trim().toUpperCase() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const { priceSatang, stock, maxPerOrder = 10, maxPerEmail = null, maxOrderCount = null, active = true } = body;
    if (!/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(sku) || !name || name.length > 120 ||
        !Number.isSafeInteger(priceSatang) || priceSatang < 0 ||
        !Number.isInteger(stock) || stock < -1 ||
        !Number.isInteger(maxPerOrder) || maxPerOrder < 1 ||
        (maxPerEmail !== null && (!Number.isInteger(maxPerEmail) || maxPerEmail < 1)) ||
        (maxOrderCount !== null && (!Number.isInteger(maxOrderCount) || maxOrderCount < 1)) ||
        typeof active !== "boolean") {
      return problem(res, 400, "INVALID_PRODUCT", "Product details are invalid");
    }
    try {
      requireSameOrigin(req);
      const client = await pool.connect();
      let product;
      try {
        await client.query("BEGIN");
        product = (await client.query(
          `INSERT INTO products
           (sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING sku, name, price_satang, stock, max_per_order, max_per_email, max_order_count, active`,
          [sku, name, priceSatang, stock, maxPerOrder, maxPerEmail, maxOrderCount, active]
        )).rows[0];
        await client.query(
          `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'product.create', 'product', $2, $3)`,
          [req.auth.id, sku, JSON.stringify({ name, priceSatang, stock, maxPerOrder, maxPerEmail, maxOrderCount, active })]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.status(201).json({ ...product, price_satang: Number(product.price_satang) });
    } catch (error) {
      return next(error);
    }
  }
);

app.get(
  "/api/v1/admin/discount-codes",
  authenticate,
  requireAdmin,
  requirePermission("orders:read"),
  async (_req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT code, discount_type, discount_value, max_discount_satang, min_order_satang,
           max_uses, uses_count, active FROM discount_codes ORDER BY code`
      );
      return res.json(result.rows.map((row) => ({
        ...row,
        discount_value: Number(row.discount_value),
        max_discount_satang: row.max_discount_satang === null ? null : Number(row.max_discount_satang),
        min_order_satang: Number(row.min_order_satang)
      })));
    } catch (error) {
      return next(error);
    }
  }
);

app.post(
  "/api/v1/admin/discount-codes",
  authenticate,
  requireAdmin,
  requirePermission("products:write"),
  async (req, res, next) => {
    const body = req.body || {};
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    const discountType = body.discountType;
    const discountValue = body.discountValue;
    const maxDiscountSatang = body.maxDiscountSatang ?? null;
    const minOrderSatang = body.minOrderSatang ?? 0;
    const maxUses = body.maxUses ?? null;
    const active = body.active ?? true;
    if (!/^[A-Z0-9_-]{2,40}$/.test(code) ||
        !["percent", "fixed"].includes(discountType) ||
        !Number.isSafeInteger(discountValue) || discountValue < 0 ||
        (discountType === "percent" && discountValue > 100) ||
        (maxDiscountSatang !== null && (!Number.isSafeInteger(maxDiscountSatang) || maxDiscountSatang < 0)) ||
        !Number.isSafeInteger(minOrderSatang) || minOrderSatang < 0 ||
        (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) ||
        typeof active !== "boolean") {
      return problem(res, 400, "INVALID_DISCOUNT_CODE", "Discount code details are invalid");
    }
    try {
      requireSameOrigin(req);
      const client = await pool.connect();
      let discount;
      try {
        await client.query("BEGIN");
        discount = (await client.query(
          `INSERT INTO discount_codes
           (code, discount_type, discount_value, max_discount_satang, min_order_satang, max_uses, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [code, discountType, discountValue, maxDiscountSatang, minOrderSatang, maxUses, active]
        )).rows[0];
        await client.query(
          `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'discount.create', 'discount_code', $2, $3)`,
          [req.auth.id, code, JSON.stringify({ discountType, discountValue, maxDiscountSatang, minOrderSatang, maxUses, active })]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.status(201).json(discount);
    } catch (error) {
      return next(error);
    }
  }
);

app.patch(
  "/api/v1/admin/discount-codes/:code",
  authenticate,
  requireAdmin,
  requirePermission("products:write"),
  async (req, res, next) => {
    const body = req.body || {};
    const active = body.active;
    if (active !== undefined && typeof active !== "boolean") {
      return problem(res, 400, "INVALID_DISCOUNT_CODE", "The active value must be boolean");
    }
    try {
      requireSameOrigin(req);
      const client = await pool.connect();
      let discount;
      try {
        await client.query("BEGIN");
        const current = await client.query(
          "SELECT * FROM discount_codes WHERE code = $1 FOR UPDATE",
          [req.params.code.toUpperCase()]
        );
        if (!current.rows[0]) throw new HttpError(404, "DISCOUNT_CODE_NOT_FOUND", "Discount code not found");
        const row = current.rows[0];
        const value = body.discountValue ?? Number(row.discount_value);
        const maxUses = body.maxUses === undefined ? row.max_uses : body.maxUses;
        if (!Number.isSafeInteger(value) || value < 0 ||
            (row.discount_type === "percent" && value > 100) ||
            (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < Number(row.uses_count)))) {
          throw new HttpError(400, "INVALID_DISCOUNT_CODE", "Discount value or maximum uses are invalid");
        }
        discount = (await client.query(
          `UPDATE discount_codes SET discount_value = $2, max_uses = $3, active = $4
           WHERE code = $1 RETURNING *`,
          [row.code, value, maxUses, active ?? row.active]
        )).rows[0];
        await client.query(
          `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'discount.update', 'discount_code', $2, $3)`,
          [req.auth.id, row.code, JSON.stringify({ discountValue: value, maxUses, active: active ?? row.active })]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.json(discount);
    } catch (error) {
      return next(error);
    }
  }
);

app.get(
  "/api/v1/admin/orders",
  authenticate,
  requireAdmin,
  requirePermission("orders:read"),
  async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const validStatuses = new Set([
      "PENDING_PAYMENT", "PAID", "IN_QUEUE", "IN_PROGRESS", "COMPLETED",
      "EXPIRED", "PAYMENT_FAILED", "FAILED", "REFUNDED", "NEEDS_REVIEW"
    ]);
    if (status && !validStatuses.has(status)) {
      throw new HttpError(400, "INVALID_STATUS", "The requested order status is invalid");
    }
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new HttpError(400, "INVALID_LIMIT", "Page size must be between 1 and 100");
    }
    const from = typeof req.query.from === "string" ? new Date(req.query.from) : null;
    const to = typeof req.query.to === "string" ? new Date(req.query.to) : null;
    if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime())) || (from && to && from > to)) {
      throw new HttpError(400, "INVALID_DATE_RANGE", "The order date filter is invalid");
    }
    const search = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (search.length > 100) throw new HttpError(400, "INVALID_SEARCH", "Search text is too long");
    const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);
    const conditions = [];
    const values = [];
    const add = (condition, value) => {
      values.push(value);
      conditions.push(condition.replace("?", `$${values.length}`));
    };
    if (status) add("status = ?", status);
    if (from) add("created_at >= ?", from);
    if (to) add("created_at <= ?", to);
    if (search) {
      values.push(`%${search}%`);
      const parameter = `$${values.length}`;
      conditions.push(`(id ILIKE ${parameter} OR email ILIKE ${parameter} OR product_name ILIKE ${parameter})`);
    }
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      conditions.push(`(created_at, id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    values.push(limit + 1);
    const result = await pool.query(
      `SELECT * FROM orders ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => {
      const order = formatOrder(row);
      if (!hasPermission(req.auth.role, "pii:read")) {
        order.email = maskEmail(order.email);
        order.playerId = "***";
      }
      return order;
    });
    const next = hasMore ? encodeCursor(rows[rows.length - 1]) : null;
    if (next) res.set("X-Next-Cursor", next);
    return res.json({ orders: items, nextCursor: next });
  } catch (error) {
    return next(error);
  }
  }
);

app.get(
  "/api/v1/admin/orders/:id",
  authenticate,
  requireAdmin,
  requirePermission("orders:read"),
  async (req, res, next) => {
    try {
      const orderResult = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
      if (!orderResult.rows[0]) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
      const order = formatOrder(orderResult.rows[0]);
      const [items, events, webhooks, fulfillments, refunds] = await Promise.all([
        pool.query("SELECT sku, product_name, player_id, unit_price_satang, quantity, game_reference FROM order_items WHERE order_id = $1 ORDER BY id", [req.params.id]),
        pool.query("SELECT id, status, actor, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY id", [req.params.id]),
        pool.query("SELECT event_id, event_type, payload, received_at FROM payment_webhook_events WHERE order_id = $1 ORDER BY received_at", [req.params.id]),
        pool.query("SELECT status, attempts, run_after, last_error, created_at FROM fulfillment_jobs WHERE order_id = $1 ORDER BY id", [req.params.id]),
        pool.query("SELECT id, amount_satang, status, attempts, created_at, completed_at FROM refund_jobs WHERE order_id = $1 ORDER BY id", [req.params.id])
      ]);
      if (!hasPermission(req.auth.role, "pii:read")) {
        order.email = maskEmail(order.email);
        order.playerId = "***";
      }
      return res.json({
        ...order,
        items: items.rows.map((item) => ({
          ...item,
          player_id: hasPermission(req.auth.role, "pii:read") ? item.player_id : "***",
          unit_price_satang: Number(item.unit_price_satang)
        })),
        events: events.rows,
        webhooks: webhooks.rows.map((event) => ({ ...event, payload: { type: event.payload.type } })),
        fulfillments: fulfillments.rows,
        refunds: refunds.rows.map((refund) => ({ ...refund, amount_satang: Number(refund.amount_satang) }))
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.get(
  "/api/v1/admin/audit-logs",
  authenticate,
  requireAdmin,
  requirePermission("audit:read"),
  async (req, res, next) => {
    try {
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, "INVALID_LIMIT", "Page size must be between 1 and 100");
      }
      const cursor = decodeCursor(typeof req.query.cursor === "string" ? req.query.cursor : null);
      const result = await pool.query(
        `SELECT a.id, a.action, a.resource_type, a.resource_id, a.details, a.created_at, u.email AS actor_email
         FROM admin_audit_logs a JOIN auth_users u ON u.id = a.actor_user_id
         WHERE $1::timestamptz IS NULL OR (a.created_at, a.id) < ($1, $2::bigint)
         ORDER BY a.created_at DESC, a.id DESC LIMIT $3`,
        [cursor?.createdAt || null, cursor?.id || null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const next = hasMore ? encodeCursor(rows[rows.length - 1]) : null;
      return res.json({
        logs: rows.map((row) => ({ ...row, actor_email: maskEmail(row.actor_email) })),
        nextCursor: next
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.get(
  "/api/v1/admin/dashboard",
  authenticate,
  requireAdmin,
  requirePermission("dashboard:read"),
  async (_req, res, next) => {
    try {
      const [statuses, counts, sales] = await Promise.all([
        pool.query("SELECT status, COUNT(*)::bigint AS count FROM orders GROUP BY status"),
        pool.query(
          `SELECT COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 minute')::bigint AS orders_per_minute,
             (SELECT COUNT(*) FROM fulfillment_jobs WHERE status IN ('queued', 'retry'))::bigint AS queue_depth,
             (SELECT COUNT(*) FROM fulfillment_jobs WHERE status = 'dead')::bigint AS dead_letter`
        ),
        pool.query(
          `SELECT COALESCE(SUM(total_satang - refunded_satang), 0)::bigint AS sales_today
           FROM orders WHERE status IN ('PAID', 'IN_QUEUE', 'IN_PROGRESS', 'COMPLETED')
             AND created_at >= date_trunc('day', NOW())`
        )
      ]);
      return res.json({
        ordersByStatus: Object.fromEntries(statuses.rows.map((row) => [row.status, Number(row.count)])),
        ordersPerMinute: Number(counts.rows[0].orders_per_minute),
        queueDepth: Number(counts.rows[0].queue_depth),
        deadLetter: Number(counts.rows[0].dead_letter),
        salesTodaySatang: Number(sales.rows[0].sales_today)
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.get(
  "/api/v1/admin/users",
  authenticate,
  requireAdmin,
  requirePermission("users:write"),
  async (req, res, next) => {
    try {
      const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new HttpError(400, "INVALID_LIMIT", "Page size must be between 1 and 100");
      }
      const result = await pool.query(
        `SELECT id, email, role, role_source, created_at, updated_at
         FROM auth_users ORDER BY created_at DESC, id LIMIT $1`,
        [limit]
      );
      return res.json(result.rows.map((user) => ({
        ...user,
        email: hasPermission(req.auth.role, "pii:read") ? user.email : maskEmail(user.email)
      })));
    } catch (error) {
      return next(error);
    }
  }
);

app.patch(
  "/api/v1/admin/users/:id/role",
  authenticate,
  requireAdmin,
  requirePermission("users:write"),
  async (req, res, next) => {
    const role = req.body?.role;
    if (!["customer", "viewer", "support", "finance", "superadmin", "admin"].includes(role)) {
      return problem(res, 400, "INVALID_ROLE", "Choose a supported account role");
    }
    try {
      const client = await pool.connect();
      let updated;
      try {
        await client.query("BEGIN");
        const current = await client.query(
          "SELECT id, email, role, role_source FROM auth_users WHERE id = $1 FOR UPDATE",
          [req.params.id]
        );
        if (!current.rows[0]) throw new HttpError(404, "USER_NOT_FOUND", "User not found");
        if (configuredRoleEmails.has(normalizeEmail(current.rows[0].email))) {
          throw new HttpError(409, "ROLE_CONFIGURED_BY_ENV", "This user's role is managed by the deployment environment");
        }
        updated = (await client.query(
          `UPDATE auth_users SET role = $2, role_source = 'manual', updated_at = NOW()
           WHERE id = $1 RETURNING id, email, role, role_source, updated_at`,
          [req.params.id, role]
        )).rows[0];
        await client.query(
          `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
           VALUES ($1, 'user.role.update', 'user', $2, $3)`,
          [req.auth.id, updated.id, JSON.stringify({ role })]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return res.json({
        ...updated,
        email: hasPermission(req.auth.role, "pii:read") ? updated.email : maskEmail(updated.email)
      });
    } catch (error) {
      return next(error);
    }
  }
);

app.post(
  "/api/v1/admin/orders/:id/retry-fulfillment",
  authenticate,
  requireAdmin,
  requirePermission("fulfillment:retry"),
  async (req, res, next) => {
    try {
      if (!validOrderId(req.params.id)) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
      const client = await pool.connect();
      let event;
      try {
        await client.query("BEGIN");
        const orderResult = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
        const order = orderResult.rows[0];
        if (!order) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
        if (!["FAILED", "PAID", "IN_QUEUE", "IN_PROGRESS"].includes(order.status)) {
          throw new HttpError(409, "ORDER_NOT_RETRYABLE", "The order cannot be retried in its current state");
        }
        const refund = await client.query(
          "SELECT id, status FROM refund_jobs WHERE order_id = $1 AND status IN ('queued', 'in_progress', 'retry', 'done') FOR UPDATE",
          [order.id]
        );
        if (refund.rows.some((row) => ["in_progress", "done"].includes(row.status))) {
          throw new HttpError(409, "REFUND_ALREADY_STARTED", "The order has an active or completed refund");
        }
        await client.query(
          `UPDATE refund_jobs SET status = 'dead', last_error = 'Cancelled for support fulfillment retry'
           WHERE order_id = $1 AND status IN ('queued', 'retry')`,
          [order.id]
        );
        await client.query(
          `INSERT INTO fulfillment_jobs (order_id, status, attempts, run_after)
           VALUES ($1, 'queued', 0, NOW())
           ON CONFLICT (order_id) DO UPDATE SET status = 'queued', attempts = 0,
             run_after = NOW(), locked_at = NULL, last_error = NULL`,
          [order.id]
        );
        if (order.status === "FAILED") {
          event = await recordStatus(client, order.id, "IN_QUEUE", "support", "Support requested fulfillment retry");
        }
        await client.query(
          `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id)
           VALUES ($1, 'fulfillment.retry', 'order', $2)`,
          [req.auth.id, order.id]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (event) await publishOrderEvent({ ...event, order_id: req.params.id });
      return res.status(202).json({ status: "retry_queued", orderId: req.params.id });
    } catch (error) {
      return next(error);
    }
  }
);

app.get(
  "/api/v1/admin/refund-requests",
  authenticate,
  requireAdmin,
  requirePermission("refund:write"),
  async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT r.id, r.order_id, r.requested_by, r.reason, r.status, r.created_at,
              o.email, o.product_name, o.total_satang, o.status AS order_status
       FROM refund_requests r JOIN orders o ON o.id = r.order_id
       WHERE r.status = 'pending' ORDER BY r.created_at ASC LIMIT 100`
    );
    return res.json(result.rows.map((row) => ({
      ...row,
      total_satang: Number(row.total_satang)
    })));
  } catch (error) {
    return next(error);
  }
  }
);

app.post(
  "/api/v1/admin/refund-requests/:id/:decision",
  authenticate,
  requireAdmin,
  requirePermission("refund:write"),
  async (req, res, next) => {
  const { decision } = req.params;
  const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
  if (!["approve", "reject"].includes(decision) ||
      (decision === "reject" && (note.length < 3 || note.length > 300))) {
    return problem(res, 400, "INVALID_REFUND_DECISION", "Choose approve or provide a rejection note between 3 and 300 characters");
  }
  try {
    requireSameOrigin(req);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const requestResult = await client.query(
        `SELECT r.*, o.status AS order_status, o.total_satang
         FROM refund_requests r JOIN orders o ON o.id = r.order_id
         WHERE r.id = $1 FOR UPDATE OF r, o`,
        [req.params.id]
      );
      const request = requestResult.rows[0];
      if (!request) throw new HttpError(404, "REFUND_REQUEST_NOT_FOUND", "Refund request not found");
      if (request.status !== "pending") {
        throw new HttpError(409, "REFUND_REQUEST_ALREADY_RESOLVED", "This refund request has already been resolved");
      }
      if (decision === "approve") {
        if (!["COMPLETED", "FAILED", "NEEDS_REVIEW"].includes(request.order_status)) {
          throw new HttpError(409, "ORDER_NOT_REFUNDABLE", "This order cannot be refunded in its current state");
        }
        const pending = await client.query(
          `SELECT COALESCE(SUM(amount_satang), 0)::bigint AS amount
           FROM refund_jobs WHERE order_id = $1 AND status IN ('queued', 'in_progress', 'retry')`,
          [request.order_id]
        );
        const amount = BigInt(request.total_satang) - BigInt(pending.rows[0].amount) -
          BigInt((await client.query("SELECT refunded_satang FROM orders WHERE id = $1", [request.order_id])).rows[0].refunded_satang);
        if (amount < 0n) throw new HttpError(409, "REFUND_AMOUNT_EXCEEDED", "Pending refunds exceed the remaining paid balance");
        if (amount > 0n) {
          await client.query(
            `INSERT INTO refund_jobs (order_id, amount_satang, requested_by, reason)
             VALUES ($1, $2, $3, $4)`,
            [request.order_id, amount.toString(), req.auth.id, request.reason]
          );
        }
      }
      await client.query(
        `UPDATE refund_requests SET status = $2, admin_note = $3, updated_at = NOW()
         WHERE id = $1`,
        [request.id, decision === "approve" ? "approved" : "rejected", decision === "approve" ? null : note]
      );
      await client.query(
        `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, $2, 'order', $3, $4)`,
        [
          req.auth.id,
          `refund_request.${decision}`,
          request.order_id,
          JSON.stringify({ requestId: request.id, note: decision === "reject" ? note : undefined })
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return res.json({ status: decision === "approve" ? "refund_queued" : "rejected" });
  } catch (error) {
    return next(error);
  }
  }
);

app.post(
  "/api/v1/admin/orders/:id/refund",
  authenticate,
  requireAdmin,
  requirePermission("refund:write"),
  async (req, res, next) => {
  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (reason.length < 3 || reason.length > 300) {
    return problem(res, 400, "INVALID_REFUND_REASON", "Provide a refund reason between 3 and 300 characters");
  }
  const key = req.get("Idempotency-Key");
  if (!key || key.length > 200) {
    return problem(res, 400, "IDEMPOTENCY_KEY_REQUIRED", "Provide a valid Idempotency-Key header");
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const existingKey = await client.query(
        "SELECT request_hash, refund_job_id FROM refund_idempotency WHERE idempotency_key = $1 FOR UPDATE",
        [key]
      );
      if (existingKey.rows[0]) {
        const existingJob = await client.query(
          "SELECT amount_satang FROM refund_jobs WHERE id = $1",
          [existingKey.rows[0].refund_job_id]
        );
        const requestedAmount = req.body?.amountSatang === undefined
          ? Number(existingJob.rows[0]?.amount_satang)
          : Number(req.body.amountSatang);
        const requestHash = crypto.createHash("sha256")
          .update(JSON.stringify({ orderId: order.id, amountSatang: requestedAmount, reason }))
          .digest("hex");
        if (existingKey.rows[0].request_hash !== requestHash) {
          throw new HttpError(422, "IDEMPOTENCY_KEY_REUSED", "This key was already used with a different refund request");
        }
        await client.query("COMMIT");
        return res.status(202).json({
          status: "refund_queued",
          orderId: order.id,
          refundId: Number(existingKey.rows[0].refund_job_id)
        });
      }
      if (!["COMPLETED", "FAILED", "NEEDS_REVIEW"].includes(order.status)) {
        throw new HttpError(409, "ORDER_NOT_REFUNDABLE", "This order cannot be refunded in its current state");
      }
      const requestedAmount = req.body?.amountSatang === undefined
        ? Number(order.total_satang) - Number(order.refunded_satang)
        : Number(req.body.amountSatang);
      if (!Number.isSafeInteger(requestedAmount) || requestedAmount <= 0) {
        throw new HttpError(400, "INVALID_REFUND_AMOUNT", "Refund amount must be a positive integer number of satang");
      }
      const requestHash = crypto.createHash("sha256")
        .update(JSON.stringify({ orderId: order.id, amountSatang: requestedAmount, reason }))
        .digest("hex");
      const pendingResult = await client.query(
        `SELECT COALESCE(SUM(amount_satang), 0)::bigint AS amount
         FROM refund_jobs WHERE order_id = $1 AND status IN ('queued', 'in_progress', 'retry')`,
        [order.id]
      );
      const remaining = BigInt(order.total_satang) - BigInt(order.refunded_satang || 0) -
        BigInt(pendingResult.rows[0].amount);
      if (BigInt(requestedAmount) > remaining) {
        throw new HttpError(409, "REFUND_AMOUNT_EXCEEDED", "Refund amount exceeds the remaining refundable balance");
      }
      const job = await client.query(
        `INSERT INTO refund_jobs (order_id, amount_satang, requested_by, reason, actor_user_id)
         VALUES ($1, $2, $3, $4, $3) RETURNING id`,
        [order.id, requestedAmount, req.auth.id, reason]
      );
      const refundId = Number(job.rows[0].id);
      await client.query(
        "INSERT INTO refund_idempotency (idempotency_key, request_hash, refund_job_id) VALUES ($1, $2, $3)",
        [key, requestHash, job.rows[0].id]
      );
      await client.query(
        `UPDATE refund_requests SET status = 'approved', updated_at = NOW()
         WHERE order_id = $1 AND status = 'pending'`,
        [order.id]
      );
      await client.query(
        `INSERT INTO admin_audit_logs (actor_user_id, action, resource_type, resource_id, details)
         VALUES ($1, 'order.refund.request', 'order', $2, $3)`,
        [req.auth.id, order.id, JSON.stringify({ amountSatang: requestedAmount, reason, refundId })]
      );
      await client.query("COMMIT");
      return res.status(202).json({ status: "refund_queued", orderId: order.id, refundId });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return next(error);
  }
  }
);

app.post(
  "/api/v1/admin/reconciliation/import",
  authenticate,
  requireAdmin,
  requirePermission("reconciliation:write"),
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

app.get(
  "/api/v1/admin/reconciliation",
  authenticate,
  requireAdmin,
  requirePermission("reconciliation:write"),
  async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, file_name, row_count, matched_count, mismatch_count, status, created_at
       FROM reconciliation_batches ORDER BY created_at DESC LIMIT 50`
    );
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
  }
);

app.get(
  "/api/v1/admin/reconciliation/:id",
  authenticate,
  requireAdmin,
  requirePermission("reconciliation:write"),
  async (req, res, next) => {
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
  }
);

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

app.get("/api/v1/orders/:id", authenticate, async (req, res, next) => {
  try {
    if (!validOrderId(req.params.id)) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
    const result = await pool.query(
      "SELECT * FROM orders WHERE id = $1 AND ($2::boolean OR lower(email) = $3)",
      [req.params.id, staffRoles.has(req.auth.role), req.auth.email]
    );
    if (!result.rows[0]) throw new HttpError(404, "ORDER_NOT_FOUND", "Order not found");
    const row = result.rows[0];
    const [items, events] = await Promise.all([
      pool.query(
        "SELECT sku, product_name, player_id, unit_price_satang, quantity, game_reference FROM order_items WHERE order_id = $1 ORDER BY id",
        [req.params.id]
      ),
      pool.query(
        "SELECT id, status, actor, reason, created_at FROM order_events WHERE order_id = $1 ORDER BY id",
        [req.params.id]
      )
    ]);
    const formatted = formatOrder(row);
    if (!hasPermission(req.auth.role, "pii:read") && staffRoles.has(req.auth.role)) {
      formatted.email = maskEmail(formatted.email);
      formatted.playerId = "***";
    }
    return res.json({
      ...formatted,
      items: items.rows.map((item) => ({
        ...item,
        player_id: staffRoles.has(req.auth.role) && hasPermission(req.auth.role, "pii:read")
          ? item.player_id : "***",
        unit_price_satang: Number(item.unit_price_satang)
      })),
      events: events.rows
    });
  } catch (error) {
    return next(error);
  }
});

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
  if (error.code === "check_violation" && error.constraint === "orders_status_transition") {
    return problem(res, 409, "INVALID_TRANSITION", "The requested order status transition is not allowed");
  }
  if (error.code === "23505") {
    return problem(res, 409, "CONFLICT", "The request conflicts with an existing resource");
  }
  console.error(JSON.stringify({
    level: "error",
    request_id: req.requestId,
    trace_id: req.get("traceparent")?.split("-")[1] || null,
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
