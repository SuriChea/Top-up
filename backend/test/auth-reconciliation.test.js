const test = require("node:test");
const assert = require("node:assert/strict");
const {
  cookieValue,
  generateOtp,
  hashOtp,
  hashSessionToken,
  normalizeEmail,
  safeEqualHex,
  validEmail
} = require("../auth");
const { compareSettlement, parseCsv } = require("../reconciliation");

test("normalizes and validates login email addresses", () => {
  assert.equal(normalizeEmail("  ADMIN@Example.com "), "admin@example.com");
  assert.equal(validEmail("admin@example.com"), true);
  assert.equal(validEmail("invalid"), false);
});

test("creates fixed-width OTPs and constant-time comparable hashes", () => {
  const code = generateOtp();
  assert.match(code, /^\d{6}$/);
  const hash = hashOtp("a@example.com", code, "test-secret");
  assert.equal(safeEqualHex(hash, hashOtp("a@example.com", code, "test-secret")), true);
  assert.equal(safeEqualHex(hash, hashOtp("b@example.com", code, "test-secret")), false);
  assert.equal(hashSessionToken("opaque-token").length, 64);
});

test("reads only the requested cookie and tolerates malformed encoding", () => {
  assert.equal(cookieValue("other=1; inblack_session=abc%2F123", "inblack_session"), "abc/123");
  assert.equal(cookieValue("inblack_session=%XX", "inblack_session"), "");
});

test("parses quoted CSV columns and compares settlement details", () => {
  const [record] = parseCsv(
    '\uFEFFevent_id,order_id,amount_satang,currency,type\r\n"evt,1",ORD-1,1200,THB,payment.succeeded\r\n'
  );
  assert.equal(record.eventId, "evt,1");
  assert.deepEqual(compareSettlement(record, {
    event_id: "evt,1",
    order_id: "ORD-1",
    event_type: "payment.succeeded",
    payload: { amount_satang: 1200, currency: "THB" }
  }, true), {
    status: "matched",
    detail: "Settlement matches the internal payment event"
  });
});

test("rejects malformed, oversized, and incomplete settlement CSV rows", () => {
  assert.throws(() => parseCsv("event_id,order_id\n1,2"), /must include unique columns/);
  assert.throws(() => parseCsv(
    "event_id,order_id,amount_satang,currency,type\n1,2,not-money,THB,payment.succeeded"
  ), /invalid amount_satang/);
  assert.throws(() => parseCsv(
    "event_id,order_id,amount_satang,currency,type\n1,2,100,THB,payment.succeeded\n1,3,200,THB,payment.succeeded"
  ), /duplicate event_id/);
  assert.throws(() => parseCsv('event_id,order_id,amount_satang,currency,type\n"1,2,3,THB,payment.succeeded'), /unterminated/);
});

test("classifies unknown orders and missing internal payment events", () => {
  const record = { orderId: "ORD-2", amountSatang: 500, currency: "THB", type: "payment.succeeded" };
  assert.equal(compareSettlement(record, null, false).status, "unknown_order");
  assert.equal(compareSettlement(record, null, true).status, "missing_internal_event");
  assert.equal(compareSettlement(record, {
    order_id: "ORD-2",
    event_type: "payment.succeeded",
    payload: { amount_satang: 100, currency: "THB" }
  }, true).status, "amount_mismatch");
});
