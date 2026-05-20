// src/ingestion/ingest-csv.js
//
// Stage 1 — Load all 13 SDMP CSVs into Postgres.
//
// Usage:
//   node src/ingestion/ingest-csv.js                   # loads all CSVs in CSV_DIR
//   node src/ingestion/ingest-csv.js --file foo.csv    # loads one specific file
//   node src/ingestion/ingest-csv.js --dry-run         # prints DDL + row counts, no DB writes
//
// What it does per CSV:
//   1. Reads headers → derives a safe Postgres table name and column names
//   2. DROP TABLE IF EXISTS (idempotent re-runs)
//   3. CREATE TABLE with all TEXT columns (safe default; cast at query time if needed)
//   4. Bulk-inserts all rows via a single parameterised query
//   5. Logs row count + timing
//
// Requirements:
//   npm install pg csv-parse dotenv

import "dotenv/config";
import fs from "fs";
import path from "path";
import {parse} from "csv-parse/sync";
import pg from "pg";

const { Pool } = pg;

// ── Config ────────────────────────────────────────────────────────────────────

// Path to the folder that contains all 13 CSVs.
// Override with env var CSV_DIR or pass --dir <path> on CLI.
const CSV_DIR = process.env.CSV_DIR || "./csv";

// ── Postgres pool (mirrors postgres.js but self-contained for the script) ─────
const pool = new Pool({
  host:     process.env.POSTGRES_HOST     || "localhost",
  port:     Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB       || "sdmp",
  user:     process.env.POSTGRES_USER     || "postgres",
  password: process.env.POSTGRES_PASSWORD,
  max: 5,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) =>
  console.error("[postgres] Pool error:", err.message)
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Convert a CSV filename or header string to a safe Postgres identifier.
 * e.g. "sdmp_table_2_3_disaster_statistics.csv" → "sdmp_table_2_3_disaster_statistics"
 *      "District Name"  → "district_name"
 */
function toSafeIdentifier(str) {
  return str
    .replace(/\.csv$/i, "")   // strip extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")  // non-alphanum → underscore
    .replace(/^_+|_+$/g, "");     // trim leading/trailing underscores
}

/**
 * Parse a CSV file and return { tableName, columns, rows }.
 */
function parseCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");

  const records = parse(raw, {
    columns: true,        // first row = header
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,  // tolerate ragged rows gracefully
  });

  if (records.length === 0) {
    throw new Error(`CSV is empty or has only a header: ${filePath}`);
  }

  const tableName = toSafeIdentifier(path.basename(filePath));
  const columns   = Object.keys(records[0]).map(toSafeIdentifier);
  const rows      = records.map((r) => Object.values(r));

  return { tableName, columns, rows };
}

/**
 * Build and execute CREATE TABLE + bulk INSERT for one CSV.
 * Wrapped in a transaction so a partial failure leaves no half-loaded table.
 */
async function loadCsvToPostgres(filePath, dryRun = false) {
  const t0 = Date.now();
  const { tableName, columns, rows } = parseCsv(filePath);

  // ── DDL ──────────────────────────────────────────────────────────────────
  const colDefs  = columns.map((c) => `  "${c}" TEXT`).join(",\n");
  const createSql = `
CREATE TABLE IF NOT EXISTS "${tableName}" (
  _id SERIAL PRIMARY KEY,
${colDefs}
);`.trim();

  const dropSql   = `DROP TABLE IF EXISTS "${tableName}";`;
  const truncateSql = `TRUNCATE TABLE "${tableName}" RESTART IDENTITY;`;

  if (dryRun) {
    console.log(`\n[dry-run] === ${tableName} (${rows.length} rows) ===`);
    console.log(dropSql);
    console.log(createSql);
    console.log(`-- Would insert ${rows.length} rows into ${columns.length} columns`);
    return { tableName, rowsInserted: rows.length, ms: 0, dryRun: true };
  }

  // ── Bulk insert using unnest (fast, single round-trip) ───────────────────
  //
  // Strategy: build one INSERT … SELECT unnest($1), unnest($2), …
  // This avoids the N-round-trips of individual INSERTs and the
  // string-building fragility of VALUES ($1,$2), ($3,$4) …
  //
  const unnestArgs  = columns.map((_, i) => `unnest($${i + 1}::text[])`).join(", ");
  const colList     = columns.map((c) => `"${c}"`).join(", ");
  const insertSql   = `
INSERT INTO "${tableName}" (${colList})
SELECT ${unnestArgs};`.trim();

  // Transpose rows (array of row-arrays) into columns (array of column-arrays)
  const columnArrays = columns.map((_, colIdx) =>
    rows.map((row) => (row[colIdx] ?? null))   // null for missing values
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(dropSql);
    await client.query(createSql);
    const result = await client.query(insertSql, columnArrays);
    await client.query("COMMIT");

    const ms = Date.now() - t0;
    const rowsInserted = result.rowCount ?? rows.length;
    console.log(
      `[ingest-csv] ✓  ${tableName.padEnd(50)} ${String(rowsInserted).padStart(4)} rows  (${ms}ms)`
    );
    return { tableName, rowsInserted, ms, dryRun: false };

  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(`Failed loading ${tableName}: ${err.message}`);
  } finally {
    client.release();
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes("--dry-run");
  const fileIdx = args.indexOf("--file");
  const dirIdx  = args.indexOf("--dir");

  // Resolve CSV directory
  const csvDir = dirIdx !== -1 ? args[dirIdx + 1] : CSV_DIR;

  // Resolve list of files to process
  let files;
  if (fileIdx !== -1) {
    // Single file mode
    const f = args[fileIdx + 1];
    if (!fs.existsSync(f)) throw new Error(`File not found: ${f}`);
    files = [f];
  } else {
    // All CSVs in directory
    if (!fs.existsSync(csvDir)) {
      throw new Error(
        `CSV directory not found: "${csvDir}"\n` +
        `Set CSV_DIR env var or pass --dir <path>`
      );
    }
    files = fs
      .readdirSync(csvDir)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .map((f) => path.join(csvDir, f));

    if (files.length === 0) {
      throw new Error(`No CSV files found in: ${csvDir}`);
    }
  }

  console.log(
    `\n[ingest-csv] ${dryRun ? "DRY RUN — " : ""}Loading ${files.length} CSV(s) into Postgres…\n`
  );

  // Verify connection (unless dry-run)
  if (!dryRun) {
    const client = await pool.connect();
    try {
      const { rows } = await client.query(
        "SELECT current_database() AS db, version() AS ver"
      );
      console.log(`[postgres]   ✓ Connected to "${rows[0].db}"`);
      console.log(`[postgres]     ${rows[0].ver.split(",")[0]}\n`);
    } finally {
      client.release();
    }
  }

  // Process each file
  const results = [];
  const errors  = [];

  for (const filePath of files) {
    try {
      const r = await loadCsvToPostgres(filePath, dryRun);
      results.push(r);
    } catch (err) {
      console.error(`[ingest-csv] ✗  ${path.basename(filePath)}: ${err.message}`);
      errors.push({ file: filePath, error: err.message });
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalRows = results.reduce((s, r) => s + r.rowsInserted, 0);
  console.log(`
[ingest-csv] ─────────────────────────────────────────
[ingest-csv] Tables loaded : ${results.length} / ${files.length}
[ingest-csv] Total rows    : ${totalRows}
[ingest-csv] Errors        : ${errors.length}
[ingest-csv] ─────────────────────────────────────────`);

  if (errors.length > 0) {
    console.error("\n[ingest-csv] Failed files:");
    errors.forEach((e) => console.error(`  ✗ ${e.file}\n    ${e.error}`));
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[ingest-csv] Fatal:", err.message);
  process.exit(1);
});