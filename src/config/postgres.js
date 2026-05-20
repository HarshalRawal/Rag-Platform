// src/config/postgres.js
// Manages a pg Pool — single pool shared across the whole app.

import pg from "pg";
import "dotenv/config";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.POSTGRES_HOST || "localhost",
  port: Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB || "app_db",
  user: process.env.POSTGRES_USER || "admin",
  password: process.env.POSTGRES_PASSWORD||"admin",
  max: Number(process.env.POSTGRES_POOL_MAX) || 10,
  idleTimeoutMillis: Number(process.env.POSTGRES_IDLE_TIMEOUT_MS) || 30_000,
  connectionTimeoutMillis: Number(process.env.POSTGRES_CONN_TIMEOUT_MS) || 5_000,
});

// Log connection errors so they don't silently kill the pool
pool.on("error", (err) => {
  console.error("[postgres] Unexpected pool error:", err.message);
});

/**
 * Verify the pool can reach Postgres.
 * Called once at startup — throws if the DB is unreachable.
 */
export async function connectPostgres() {
  const client = await pool.connect();
  try {
    const { rows } = await client.query("SELECT NOW() AS now, current_database() AS db");
    const { now, db } = rows[0];
    console.log(`[postgres] ✓ Connected to database "${db}" at ${now}`);
  } finally {
    client.release();
  }
}

/**
 * Convenience wrapper: run a parameterised query and return rows.
 *
 * @param {string} text   SQL with $1, $2 … placeholders
 * @param {any[]}  params Parameter values
 * @returns {Promise<any[]>}
 */
export async function query(text, params = []) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const ms = Date.now() - start;
  if (process.env.NODE_ENV !== "production") {
    console.debug(`[postgres] query (${ms}ms) rows=${result.rowCount} — ${text.slice(0, 80)}`);
  }
  return result.rows;
}

export default pool;