const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const migrationDirectory = path.join(__dirname, "migrations");
  const migrations = (await fs.readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(204851, 1)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         migration_name TEXT PRIMARY KEY,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    for (const migrationName of migrations) {
      const applied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE migration_name = $1",
        [migrationName]
      );
      if (applied.rowCount) continue;
      const migration = await fs.readFile(path.join(migrationDirectory, migrationName), "utf8");
      await client.query(migration);
      await client.query(
        "INSERT INTO schema_migrations (migration_name) VALUES ($1)",
        [migrationName]
      );
    }
    const roleGroups = [
      ["ADMIN_EMAILS", "admin"],
      ["VIEWER_EMAILS", "viewer"],
      ["SUPPORT_EMAILS", "support"],
      ["FINANCE_EMAILS", "finance"],
      ["SUPERADMIN_EMAILS", "superadmin"]
    ];
    for (const [environmentKey, role] of roleGroups) {
      const emails = (process.env[environmentKey] || "")
        .split(",")
        .map((email) => email.trim().toLowerCase())
        .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
      for (const email of emails) {
        await client.query(
          `INSERT INTO auth_users (id, email, role, role_source)
           VALUES ($1, $2, $3, 'env')
           ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role,
             role_source = 'env', updated_at = NOW()`,
          [crypto.randomUUID(), email, role]
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
}

migrate()
  .then(() => console.log("Database migrations applied"))
  .catch((error) => {
    console.error("Database migration failed:", error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
