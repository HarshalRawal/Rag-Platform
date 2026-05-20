// src/utils/searchUtils.js
//
// Shared search utilities used by all agent tools.
// Extracted from the old router.js so that:
//   - Multiple agents can call them independently
//   - Tool definitions in tools.js stay thin and declarative
//   - Tests can mock these without touching agent code
//
// Exports:
//   embedQuery(text)                       → number[1536]
//   vectorSearch(query, { topK, filter })  → Qdrant hits[]
//   sqlSearch(tableName, filters)          → { rows, sql, table }
//   listTables()                           → string[]
//   describeTable(tableName)               → { columns: [{name, type}] }
//
// NOTE: No clients are created here. We reuse the singletons already
// established in src/config/postgres.js and src/config/qdrant.js, which
// index.js connects at boot. Creating extra pools/clients would open
// redundant TCP connections to both databases.

import "dotenv/config";
import OpenAI from "openai";

// Reuse the singleton pool and client from your existing config files
import pgPool        from "../config/postgres.js";   // default export = pg.Pool instance
import qdrantClient  from "../config/qdrant.js";      // default export = QdrantClient instance
import { COLLECTION } from "../config/qdrant.js";     // named export = collection name string

// ── Config ────────────────────────────────────────────────────────────────────

const EMBED_MODEL   = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
const DEFAULT_TOP_K = 5;

// ── OpenAI client (embedding only — no pool needed, stateless HTTP) ──────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Embedding ────────────────────────────────────────────────────────────────

/**
 * Embed a single query string using the configured embedding model.
 * Cached implicitly by OpenAI's API; no in-process cache needed yet.
 */
export async function embedQuery(text) {
  if (!text || typeof text !== "string") {
    throw new Error("embedQuery: text must be a non-empty string");
  }
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

// ── Qdrant vector search ─────────────────────────────────────────────────────

/**
 * Semantic search over Qdrant chunks.
 *
 * @param {string} query          - natural-language query
 * @param {object} [opts]
 * @param {number} [opts.topK=5]  - number of results
 * @param {object} [opts.filter]  - Qdrant filter, e.g.
 *                                  { must: [{ key: "document_id", match: { value: "Odisha_SDMP_2019" } }] }
 * @returns {Promise<Array>}      - Qdrant hits, each { id, score, payload }
 */
export async function vectorSearch(query, opts = {}) {
  const { topK = DEFAULT_TOP_K, filter = null } = opts;

  const vector = await embedQuery(query);

  const searchParams = {
    vector,
    limit: topK,
    with_payload: true,
    with_vector: false,
  };
  if (filter) searchParams.filter = filter;

  const results = await qdrantClient.search(COLLECTION, searchParams);
  return results;
}

// ── Postgres SQL search ──────────────────────────────────────────────────────

/**
 * Execute a parameterized SELECT against one of the ingested tables.
 *
 * The agent's query_postgres tool (see tools.js) is responsible for picking
 * the table and columns; this helper just runs the query safely with
 * identifier validation.
 *
 * @param {string} tableName   - exact table name (validated against listTables)
 * @param {object} [opts]
 * @param {string[]} [opts.columns]  - columns to select; default '*'
 * @param {object}   [opts.where]    - { column: value } pairs (AND'd, equality only)
 * @param {string}   [opts.orderBy]  - column name (validated)
 * @param {"ASC"|"DESC"} [opts.orderDir="ASC"]
 * @param {number}   [opts.limit=50]
 * @returns {Promise<{rows: object[], sql: string, table: string}>}
 */
export async function sqlSearch(tableName, opts = {}) {
  const { columns = ["*"], where = {}, orderBy, orderDir = "ASC", limit = 50 } = opts;

  // Validate table name against actual schema (defence in depth)
  const validTables = await listTables();
  if (!validTables.includes(tableName)) {
    throw new Error(`sqlSearch: unknown table '${tableName}'`);
  }

  // Validate columns
  const tableInfo = await describeTable(tableName);
  const validCols = new Set(tableInfo.columns.map((c) => c.name));

  let selectCols = "*";
  if (Array.isArray(columns) && columns.length > 0 && columns[0] !== "*") {
    for (const c of columns) {
      if (!validCols.has(c)) {
        throw new Error(`sqlSearch: column '${c}' not in '${tableName}'`);
      }
    }
    selectCols = columns.map((c) => `"${c}"`).join(", ");
  }

  // Build WHERE clause with parameter placeholders
  const whereClauses = [];
  const params = [];
  let paramIdx = 1;

  // Map column names to Postgres types so we only use ILIKE on text columns.
  // Using ILIKE on integer/numeric columns throws:
  //   "operator does not exist: integer ~~* unknown"
  const colTypeMap = new Map(tableInfo.columns.map((c) => [c.name, c.data_type]));
  const TEXT_TYPES = new Set([
    "text", "character varying", "varchar", "char", "character", "name", "citext",
  ]);

  for (const [col, val] of Object.entries(where)) {
    if (!validCols.has(col)) {
      throw new Error(`sqlSearch: filter column '${col}' not in '${tableName}'`);
    }
    const pgType = colTypeMap.get(col) ?? "";
    const isTextCol = TEXT_TYPES.has(pgType);

    // ILIKE only on text columns with string values; everything else uses =
    if (typeof val === "string" && isTextCol) {
      whereClauses.push(`"${col}" ILIKE $${paramIdx}`);
      params.push(`%${val}%`);
    } else {
      whereClauses.push(`"${col}" = $${paramIdx}`);
      params.push(val);
    }
    paramIdx += 1;
  }

  let sql = `SELECT ${selectCols} FROM "${tableName}"`;
  if (whereClauses.length > 0) sql += ` WHERE ${whereClauses.join(" AND ")}`;
  if (orderBy) {
    if (!validCols.has(orderBy)) {
      throw new Error(`sqlSearch: orderBy column '${orderBy}' not in '${tableName}'`);
    }
    const dir = orderDir.toUpperCase() === "DESC" ? "DESC" : "ASC";
    sql += ` ORDER BY "${orderBy}" ${dir}`;
  }
  sql += ` LIMIT ${Math.min(Math.max(1, Number(limit) || 50), 500)}`;

  const client = await pgPool.connect();
  try {
    const result = await client.query(sql, params);
    return { rows: result.rows, sql, table: tableName };
  } finally {
    client.release();
  }
}

// ── Schema introspection (for tool argument validation) ──────────────────────

let _tableListCache = null;

/**
 * List all user tables in the public schema.
 * Cached per process — call invalidateSchemaCache() if tables change at runtime.
 */
export async function listTables() {
  if (_tableListCache) return _tableListCache;
  const client = await pgPool.connect();
  try {
    const result = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    _tableListCache = result.rows.map((r) => r.tablename);
    return _tableListCache;
  } finally {
    client.release();
  }
}

const _tableSchemaCache = new Map();

/**
 * Get column names and types for a single table.
 * Cached per table.
 */
export async function describeTable(tableName) {
  if (_tableSchemaCache.has(tableName)) return _tableSchemaCache.get(tableName);

  const client = await pgPool.connect();
  try {
    const result = await client.query(
      `
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
      `,
      [tableName]
    );
    const info = {
      table: tableName,
      columns: result.rows.map((r) => ({ name: r.column_name, type: r.data_type })),
    };
    _tableSchemaCache.set(tableName, info);
    return info;
  } finally {
    client.release();
  }
}

export function invalidateSchemaCache() {
  _tableListCache = null;
  _tableSchemaCache.clear();
}