const requiredColumns = ["event_id", "order_id", "amount_satang", "type"];

function parseCsv(source) {
  if (typeof source !== "string" || !source.trim()) throw new Error("CSV file is empty");
  source = source.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one settlement row");

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || requiredColumns.some((column) => !headers.includes(column)) ||
      (!headers.includes("currency") && !headers.includes("settled_at"))) {
    throw new Error(`CSV must include unique columns: ${requiredColumns.join(", ")} and currency or settled_at`);
  }
  if (rows.length - 1 > 10_000) throw new Error("CSV may contain at most 10,000 rows");

  const column = Object.fromEntries(headers.map((header, index) => [header, index]));
  const parsed = rows.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`CSV row ${index + 2} has an incorrect number of columns`);
    const eventId = values[column.event_id].trim();
    const orderId = values[column.order_id].trim();
    const amount = values[column.amount_satang].trim();
    const currency = column.currency === undefined ? "THB" : values[column.currency].trim().toUpperCase();
    const type = values[column.type].trim();
    const settledAt = column.settled_at === undefined ? null : values[column.settled_at].trim();
    if (!eventId || eventId.length > 200 || !orderId || orderId.length > 100) {
      throw new Error(`CSV row ${index + 2} has an invalid event or order ID`);
    }
    if (!/^\d+$/.test(amount) || !Number.isSafeInteger(Number(amount))) {
      throw new Error(`CSV row ${index + 2} has an invalid amount_satang`);
    }
    if (!currency || currency.length > 8 || !/^payment\.(succeeded|failed|refunded)$/.test(type)) {
      throw new Error(`CSV row ${index + 2} has an invalid currency or type`);
    }
    if (column.settled_at !== undefined && (!settledAt || Number.isNaN(Date.parse(settledAt)))) {
      throw new Error(`CSV row ${index + 2} has an invalid settled_at timestamp`);
    }
    return {
      eventId,
      orderId,
      amountSatang: Number(amount),
      currency,
      type,
      settledAt
    };
  });
  if (new Set(parsed.map((record) => record.eventId)).size !== parsed.length) {
    throw new Error("CSV contains duplicate event_id values");
  }
  return parsed;
}

function compareSettlement(provider, internal, orderExists) {
  if (!orderExists) return { status: "unknown_order", detail: "No order exists for this provider record" };
  if (!internal) return { status: "missing_internal_event", detail: "Provider record has no matching internal payment event" };
  if (provider.orderId !== internal.order_id) {
    return { status: "event_mismatch", detail: "Provider and internal order IDs differ" };
  }
  const payload = internal.payload;
  if (provider.amountSatang !== Number(payload.amount_satang) || provider.currency !== payload.currency) {
    return { status: "amount_mismatch", detail: "Amount or currency differs from the internal payment event" };
  }
  if (provider.type !== internal.event_type) {
    return { status: "status_mismatch", detail: "Provider and internal payment event statuses differ" };
  }
  return { status: "matched", detail: "Settlement matches the internal payment event" };
}

module.exports = { compareSettlement, parseCsv };
