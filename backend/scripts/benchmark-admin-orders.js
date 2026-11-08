const crypto = require("node:crypto");
const { Pool } = require("pg");
const { hashSessionToken } = require("../auth");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const apiUrl = process.env.API_BASE_URL || "http://localhost:8080";
const adminEmail = (process.env.BENCHMARK_ADMIN_EMAIL || "").trim().toLowerCase();
const sampleCount = Number(process.env.BENCHMARK_REQUESTS || 100);
const warmupCount = Number(process.env.BENCHMARK_WARMUP || 10);
const p95LimitMs = 200;

function percentile(values, proportion) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * proportion) - 1];
}

async function benchmark() {
  if (!adminEmail) throw new Error("Set BENCHMARK_ADMIN_EMAIL to a configured administrator account");
  if (!Number.isInteger(sampleCount) || sampleCount < 10 || sampleCount > 1000 ||
      !Number.isInteger(warmupCount) || warmupCount < 0 || warmupCount > 100) {
    throw new Error("Benchmark requests must be 10-1,000 and warmup requests 0-100");
  }
  const result = await pool.query(
    "SELECT id FROM auth_users WHERE lower(email) = $1 AND role IN ('admin', 'superadmin')",
    [adminEmail]
  );
  if (!result.rows[0]) throw new Error(`No admin account is configured for ${adminEmail}`);

  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  await pool.query(
    `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '15 minutes')`,
    [tokenHash, result.rows[0].id]
  );

  try {
    const filterFrom = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const endpoints = [
      "/api/v1/admin/orders?limit=50",
      `/api/v1/admin/orders?limit=50&status=COMPLETED&from=${encodeURIComponent(filterFrom)}`
    ];
    const measurements = [];
    for (const endpoint of endpoints) {
      const latencies = [];
      for (let index = 0; index < warmupCount + sampleCount; index += 1) {
        const startedAt = performance.now();
        const response = await fetch(`${apiUrl}${endpoint}`, {
          headers: { Cookie: `inblack_session=${token}` }
        });
        const duration = performance.now() - startedAt;
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`${endpoint} returned HTTP ${response.status}: ${detail}`);
        }
        const page = await response.json();
        if (!Array.isArray(page.orders)) throw new Error(`${endpoint} response is missing its orders array`);
        if (index >= warmupCount) latencies.push(duration);
      }
      measurements.push({
        endpoint: `GET ${endpoint}`,
        samples: sampleCount,
        warmup: warmupCount,
        medianMs: Number(percentile(latencies, 0.5).toFixed(2)),
        p95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
        maxMs: Number(Math.max(...latencies).toFixed(2))
      });
    }
    console.log(JSON.stringify({ p95LimitMs, measurements }));
    const failing = measurements.find((measurement) => measurement.p95Ms >= p95LimitMs);
    if (failing) throw new Error(`${failing.endpoint} p95 ${failing.p95Ms}ms exceeds the ${p95LimitMs}ms limit`);
  } finally {
    await pool.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
  }
}

benchmark()
  .catch((error) => {
    console.error(JSON.stringify({ level: "error", message: "admin_orders_benchmark_failed", error: error.message }));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
