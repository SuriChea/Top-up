const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { hashSessionToken } = require("../auth");

const apiUrl = process.env.API_BASE_URL || "http://localhost:8080";
const mockPayUrl = process.env.MOCK_PAY_PUBLIC_URL || "http://localhost:4001";
const mailpitUrl = process.env.MAILPIT_API_URL || "http://127.0.0.1:8025";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const origin = process.env.WEB_ORIGIN?.split(",")[0] || "http://localhost:3000";

async function makeSessions(count, prefix, role = "customer") {
  const users = [];
  for (let index = 0; index < count; index += 1) {
    const email = `${prefix}-${index}-${crypto.randomUUID()}@example.test`;
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(32).toString("base64url");
    users.push({ id, email, role, token });
  }
  await pool.query(
    `INSERT INTO auth_users (id, email, role, role_source)
     SELECT id, email, role, 'manual'
     FROM jsonb_to_recordset($1::jsonb) AS generated(id text, email text, role text)`,
    [JSON.stringify(users)]
  );
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     SELECT token_hash, user_id, NOW() + INTERVAL '1 hour'
     FROM jsonb_to_recordset($1::jsonb) AS generated(token_hash text, user_id text)`,
    [JSON.stringify(users.map((user) => ({
      token_hash: hashSessionToken(user.token),
      user_id: user.id
    })))]
  );
  return users.map(({ email, token }) => ({ email, cookie: `inblack_session=${token}` }));
}

after(() => pool.end());

async function requestOrder(session, key, body) {
  return fetch(`${apiUrl}/api/v1/orders`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
      Cookie: session.cookie,
      Origin: origin
    },
    body: JSON.stringify({ ...body, email: session.email })
  });
}

async function orderStatus(orderId, session) {
  const response = await fetch(`${apiUrl}/api/v1/orders/${encodeURIComponent(orderId)}`, {
    headers: { Cookie: session.cookie }
  });
  if (!response.ok) throw new Error(`Order lookup failed with HTTP ${response.status}`);
  return response.json();
}

async function waitForOrder(orderId, session, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await orderStatus(orderId, session);
    if (predicate(order)) return order;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for order ${orderId}`);
}

async function waitForReceipt(orderId, email, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query(
      "SELECT status FROM email_outbox WHERE order_id = $1 AND message_type = 'receipt'",
      [orderId]
    );
    if (result.rows[0]?.status === "sent") {
      const listResponse = await fetch(`${mailpitUrl}/api/v1/messages?limit=100`);
      if (!listResponse.ok) throw new Error(`Mailpit returned HTTP ${listResponse.status}`);
      const list = await listResponse.json();
      const message = (list.messages || []).find((item) => JSON.stringify(item.To || item).includes(email));
      if (message?.ID) {
        const detailResponse = await fetch(`${mailpitUrl}/api/v1/message/${encodeURIComponent(message.ID)}`);
        if (!detailResponse.ok) throw new Error(`Mailpit message lookup returned HTTP ${detailResponse.status}`);
        const detail = await detailResponse.json();
        const content = [detail.Subject, detail.Text, detail.HTML].join("\n");
        if (content.includes(orderId)) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for receipt email for order ${orderId}`);
}

test("PostgreSQL/Redis concurrency, idempotency, purchase limits, refunds, and RBAC", {
  skip: process.env.RUN_INTEGRATION_TESTS !== "1"
}, async () => {
  const reset = await fetch(`${apiUrl}/api/v1/_test/reset`, { method: "POST" });
  assert.equal(reset.status, 200, "integration tests require APP_ENV=test and a running Compose stack");

  const otpEmail = `otp-alias-${crypto.randomUUID()}@example.test`;
  const otpRequest = await fetch(`${apiUrl}/api/v1/auth/otp/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: otpEmail })
  });
  assert.equal(otpRequest.status, 202);
  const otpVerify = await fetch(`${apiUrl}/api/v1/auth/otp/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: otpEmail, code: "invalid" })
  });
  assert.equal(otpVerify.status, 400);

  const [idempotentUser] = await makeSessions(1, "idempotency");
  const request = {
    sku: "DIAMOND-1000",
    quantity: 1,
    playerId: "test-player",
    paymentMethod: "promptpay"
  };
  const key = crypto.randomUUID();
  const duplicateResponses = await Promise.all(
    Array.from({ length: 20 }, () => requestOrder(idempotentUser, key, request))
  );
  const duplicateBodies = await Promise.all(duplicateResponses.map((response) => response.text()));
  assert.ok(duplicateResponses.every((response) => response.status === 201));
  assert.equal(new Set(duplicateBodies).size, 1, "same idempotency request returns identical response bytes");
  const duplicateOrder = JSON.parse(duplicateBodies[0]);
  const orderCount = await pool.query("SELECT COUNT(*)::integer AS count FROM orders");
  assert.equal(orderCount.rows[0].count, 1, "concurrent idempotent requests create one order");

  const changedBody = await requestOrder(idempotentUser, key, {
    ...request,
    quantity: 2
  });
  assert.equal(changedBody.status, 422);

  const [limitedUser] = await makeSessions(1, "per-email");
  const firstLimited = await requestOrder(limitedUser, crypto.randomUUID(), {
    sku: "FLASH-SKIN-01",
    quantity: 2,
    playerId: "limited-player",
    paymentMethod: "promptpay"
  });
  assert.equal(firstLimited.status, 201);
  const secondLimited = await requestOrder(limitedUser, crypto.randomUUID(), {
    sku: "FLASH-SKIN-01",
    quantity: 1,
    playerId: "limited-player",
    paymentMethod: "promptpay"
  });
  assert.equal(secondLimited.status, 409);

  const [monthlyUser] = await makeSessions(1, "monthly-pass");
  const monthlyOrder = {
    sku: "MONTHLY-PASS",
    quantity: 1,
    playerId: "monthly-player",
    paymentMethod: "promptpay"
  };
  assert.equal((await requestOrder(monthlyUser, crypto.randomUUID(), monthlyOrder)).status, 201);
  assert.equal((await requestOrder(monthlyUser, crypto.randomUUID(), monthlyOrder)).status, 409);

  const flashCustomers = await makeSessions(120, "flash-sale");
  const flashResponses = await Promise.all(flashCustomers.map((session) =>
    requestOrder(session, crypto.randomUUID(), {
      sku: "FLASH-SKIN-01",
      quantity: 1,
      playerId: "flash-player",
      paymentMethod: "promptpay"
    })
  ));
  const successfulFlashOrders = flashResponses.filter((response) => response.status === 201);
  assert.equal(successfulFlashOrders.length, 98, "only the remaining finite stock can be reserved");
  assert.equal(flashResponses.filter((response) => response.status === 409).length, 22);
  const flashInventory = await pool.query(
    `SELECT p.stock,
       COALESCE(SUM(i.quantity), 0)::integer AS reserved
     FROM products p LEFT JOIN order_items i ON i.sku = p.sku
     WHERE p.sku = 'FLASH-SKIN-01'
     GROUP BY p.stock`
  );
  assert.equal(flashInventory.rows[0].stock, 0);
  assert.equal(flashInventory.rows[0].reserved, 100);

  const couponUsers = await makeSessions(20, "coupon");
  const couponRequest = {
    sku: "DIAMOND-1000",
    quantity: 1,
    playerId: "coupon-player",
    discountCode: "SAVE10",
    paymentMethod: "promptpay"
  };
  const firstCoupon = await requestOrder(couponUsers[0], crypto.randomUUID(), couponRequest);
  assert.equal(firstCoupon.status, 201);
  const reusedCoupon = await requestOrder(couponUsers[0], crypto.randomUUID(), couponRequest);
  assert.equal(reusedCoupon.status, 409, "a customer can only use SAVE10 once");
  const remainingCouponResponses = await Promise.all(couponUsers.slice(1).map((session) =>
    requestOrder(session, crypto.randomUUID(), couponRequest)
  ));
  const couponResponses = [firstCoupon, ...remainingCouponResponses];
  assert.equal(couponResponses.filter((response) => response.status === 201).length, 10);
  const couponErrors = await Promise.all(
    remainingCouponResponses.map(async (response) => ({ status: response.status, body: await response.json() }))
  );
  assert.equal(couponErrors.filter(({ body }) => body.code === "VOUCHER_EXHAUSTED").length, 10);
  const couponUsage = await pool.query(
    "SELECT uses_count FROM discount_codes WHERE code = 'SAVE10'"
  );
  assert.equal(couponUsage.rows[0].uses_count, 10);

  const [multiUser] = await makeSessions(1, "multi-item");
  const multiPurchase = await requestOrder(multiUser, crypto.randomUUID(), {
    items: [
      { sku: "DIAMOND-1000", quantity: 1, playerId: "multi-player-one" },
      { sku: "DIAMOND-5000", quantity: 1, playerId: "multi-player-two" }
    ],
    paymentMethod: "promptpay"
  });
  assert.equal(multiPurchase.status, 201);
  const multiOrder = await multiPurchase.json();
  assert.equal(multiOrder.items.length, 2);
  const multiPayment = await fetch(`${mockPayUrl}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderId: multiOrder.id,
      amountSatang: multiOrder.totalSatang,
      mode: "duplicate"
    })
  });
  assert.equal(multiPayment.status, 202);
  await waitForOrder(multiOrder.id, multiUser, (order) => order.status === "COMPLETED");
  await waitForReceipt(multiOrder.id, multiUser.email);
  const multiTopups = await pool.query(
    "SELECT reference, COUNT(*)::integer AS count FROM mock_game_topups WHERE reference = ANY($1::text[]) GROUP BY reference",
    [[`${multiOrder.id}:DIAMOND-1000`, `${multiOrder.id}:DIAMOND-5000`]]
  );
  assert.equal(multiTopups.rowCount, 2);
  assert.ok(multiTopups.rows.every((row) => row.count === 1), "duplicate webhooks must never duplicate item fulfillment");

  const [refundCustomer] = await makeSessions(1, "refund-customer");
  const adminEmail = process.env.E2E_ADMIN_EMAIL || "admin@example.test";
  const adminRow = await pool.query("SELECT id FROM auth_users WHERE email = $1", [adminEmail]);
  assert.ok(adminRow.rows[0], "CI must seed an admin role email");
  const adminToken = crypto.randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
    [hashSessionToken(adminToken), adminRow.rows[0].id]
  );
  const admin = { cookie: `inblack_session=${adminToken}` };
  const purchase = await requestOrder(refundCustomer, crypto.randomUUID(), request);
  assert.equal(purchase.status, 201);
  const purchased = await purchase.json();
  const payment = await fetch(`${mockPayUrl}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderId: purchased.id,
      amountSatang: purchased.totalSatang,
      mode: "success"
    })
  });
  assert.equal(payment.status, 202);
  const completed = await waitForOrder(purchased.id, refundCustomer, (order) => order.status === "COMPLETED");
  const refunds = await Promise.all([0, 1].map(() => fetch(
    `${apiUrl}/api/v1/admin/orders/${encodeURIComponent(purchased.id)}/refund`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        Cookie: admin.cookie,
        Origin: origin
      },
      body: JSON.stringify({ reason: "Concurrent refund test", amountSatang: 20_000 })
    }
  )));
  assert.deepEqual(refunds.map((response) => response.status).sort(), [202, 409]);
  const partiallyRefunded = await waitForOrder(
    purchased.id,
    refundCustomer,
    (order) => order.refundedSatang === 20_000
  );
  assert.equal(partiallyRefunded.status, "COMPLETED");
  const remainingRefund = await fetch(
    `${apiUrl}/api/v1/admin/orders/${encodeURIComponent(purchased.id)}/refund`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        Cookie: admin.cookie,
        Origin: origin
      },
      body: JSON.stringify({
        reason: "Remaining balance",
        amountSatang: completed.totalSatang - 20_000
      })
    }
  );
  assert.equal(remainingRefund.status, 202);
  const refunded = await waitForOrder(purchased.id, refundCustomer, (order) => order.status === "REFUNDED");
  assert.equal(refunded.refundedSatang, refunded.totalSatang);

  const [outsider] = await makeSessions(1, "order-outsider");
  const idorResponse = await fetch(`${apiUrl}/api/v1/orders/${encodeURIComponent(purchased.id)}`, {
    headers: { Cookie: outsider.cookie }
  });
  assert.equal(idorResponse.status, 404, "another customer's order is hidden from the viewer");
  const [viewer] = await makeSessions(1, "viewer", "viewer");
  const viewerOrders = await fetch(`${apiUrl}/api/v1/admin/orders?limit=1`, {
    headers: { Cookie: viewer.cookie }
  });
  assert.equal(viewerOrders.status, 200);
  const viewerPage = await viewerOrders.json();
  assert.equal(viewerPage.orders.length, 1);
  assert.ok(viewerPage.nextCursor, "admin order pagination exposes a cursor when another page exists");
  const nextViewerPage = await fetch(
    `${apiUrl}/api/v1/admin/orders?limit=1&cursor=${encodeURIComponent(viewerPage.nextCursor)}`,
    { headers: { Cookie: viewer.cookie } }
  );
  assert.equal(nextViewerPage.status, 200);
  const nextPage = await nextViewerPage.json();
  assert.notEqual(nextPage.orders[0].id, viewerPage.orders[0].id);
  assert.match(viewerPage.orders[0].email, /\*/);
  assert.equal(viewerPage.orders[0].playerId, "***");
  const viewerRefund = await fetch(`${apiUrl}/api/v1/admin/orders/${encodeURIComponent(purchased.id)}/refund`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
      Cookie: viewer.cookie,
      Origin: origin
    },
    body: JSON.stringify({ reason: "Not permitted" })
  });
  assert.equal(viewerRefund.status, 403);
});
