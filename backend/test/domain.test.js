const test = require("node:test");
const assert = require("node:assert/strict");
const { calculateTotals, newOrderId, validOrderId } = require("../domain");

test("matches the card pricing example to the satang", () => {
  const result = calculateTotals(
    [34900],
    [2],
    { discount_type: "percent", discount_value: "10", max_discount_satang: "5000" },
    "card"
  );
  assert.deepEqual(result, {
    subtotalSatang: 69800,
    discountSatang: 5000,
    feeSatang: 2180,
    vatSatang: 4382,
    totalSatang: 66980
  });
});

test("matches the multi-product wallet pricing example to the satang", () => {
  const result = calculateTotals(
    [17900, 9900],
    [1, 1],
    { discount_type: "fixed", discount_value: "2000", max_discount_satang: null },
    "truemoney"
  );
  assert.deepEqual(result, {
    subtotalSatang: 27800,
    discountSatang: 2000,
    feeSatang: 387,
    vatSatang: 1713,
    totalSatang: 26187
  });
});

test("matches the PromptPay pricing example to the satang", () => {
  const result = calculateTotals(
    [159000],
    [1],
    { discount_type: "percent", discount_value: "10", max_discount_satang: "5000" },
    "promptpay"
  );
  assert.deepEqual(result, {
    subtotalSatang: 159000,
    discountSatang: 5000,
    feeSatang: 0,
    vatSatang: 10075,
    totalSatang: 154000
  });
});

test("rounds wallet fees up and caps percentage discounts", () => {
  const result = calculateTotals(
    [10001],
    [1],
    { discount_type: "percent", discount_value: "10", max_discount_satang: "500" },
    "truemoney"
  );
  assert.equal(result.discountSatang, 500);
  assert.equal(result.feeSatang, 143);
});

test("creates non-sequential order IDs with valid checksums", () => {
  const ids = new Set(Array.from({ length: 20 }, newOrderId));
  assert.equal(ids.size, 20);
  for (const id of ids) {
    assert.match(id, /^ORD-\d{13}-\d{3}$/);
    assert.equal(validOrderId(id), true);
  }
  assert.equal(validOrderId("ORD-2587965432159-229"), true);
  assert.equal(validOrderId("ORD-2587965432159-458"), false);
});
