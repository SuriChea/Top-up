const crypto = require("node:crypto");

const statusTransitions = {
  PENDING_PAYMENT: new Set(["PAID", "EXPIRED", "PAYMENT_FAILED", "NEEDS_REVIEW"]),
  PAID: new Set(["IN_QUEUE", "REFUNDED", "NEEDS_REVIEW"]),
  IN_QUEUE: new Set(["IN_PROGRESS", "FAILED", "REFUNDED", "NEEDS_REVIEW"]),
  IN_PROGRESS: new Set(["IN_QUEUE", "COMPLETED", "FAILED", "REFUNDED", "NEEDS_REVIEW"]),
  COMPLETED: new Set(["REFUNDED", "NEEDS_REVIEW"]),
  EXPIRED: new Set(["PAID", "NEEDS_REVIEW"]),
  PAYMENT_FAILED: new Set(["PAID", "NEEDS_REVIEW"]),
  FAILED: new Set(["IN_QUEUE", "REFUNDED", "NEEDS_REVIEW"]),
  NEEDS_REVIEW: new Set(["PAID", "FAILED", "REFUNDED"]),
  REFUNDED: new Set(["NEEDS_REVIEW"])
};

function canTransitionOrder(from, to) {
  return from === to || statusTransitions[from]?.has(to) === true;
}

function validOrderId(id) {
  const match = /^ORD-(\d{13})-(\d{3})$/.exec(id || "");
  return Boolean(match && String(Number(match[1]) % 997).padStart(3, "0") === match[2]);
}

function newOrderId() {
  const digits = String(crypto.randomInt(1_000_000_000_000, 10_000_000_000_000));
  return `ORD-${digits}-${String(Number(digits) % 997).padStart(3, "0")}`;
}

function roundHalfUp(numerator, denominator) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

function calculateTotals(unitPrices, quantities, discount, paymentMethod) {
  const subtotal = unitPrices.reduce((sum, price, index) =>
    sum + BigInt(price) * BigInt(quantities[index]), 0n);
  let discountAmount = 0n;

  if (discount) {
    discountAmount = discount.discount_type === "percent"
      ? subtotal * BigInt(discount.discount_value) / 100n
      : BigInt(discount.discount_value);
    if (discount.max_discount_satang !== null) {
      discountAmount = discountAmount < BigInt(discount.max_discount_satang)
        ? discountAmount : BigInt(discount.max_discount_satang);
    }
    discountAmount = discountAmount < subtotal ? discountAmount : subtotal;
  }

  const net = subtotal - discountAmount;
  const fee = paymentMethod === "truemoney"
    ? (net * 15n + 999n) / 1000n
    : paymentMethod === "card"
      ? (net * 29n + 999n) / 1000n + 300n
      : 0n;
  const total = net + fee;
  const vat = total - roundHalfUp(total * 100n, 107n);

  for (const amount of [subtotal, discountAmount, fee, total, vat]) {
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      const error = new Error("The order amount is too large");
      error.code = "AMOUNT_TOO_LARGE";
      error.status = 400;
      throw error;
    }
  }
  return {
    subtotalSatang: Number(subtotal),
    discountSatang: Number(discountAmount),
    feeSatang: Number(fee),
    totalSatang: Number(total),
    vatSatang: Number(vat)
  };
}

module.exports = { calculateTotals, canTransitionOrder, newOrderId, validOrderId };
