const fs = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const migration = await fs.readFile(
    path.join(__dirname, "migrations", "002_auth_admin_reconciliation.sql"),
    "utf8"
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

migrate()
  .then(() => console.log("Database migration 002 applied"))
  .catch((error) => {
    console.error("Database migration failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
