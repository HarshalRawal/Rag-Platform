// src/agents/tools.js
//
// Tool definitions for all specialist agents.
// Each tool: { description, input_schema, execute }
//
// MODEL SPLIT:
//   Embeddings → OpenAI text-embedding-3-small  (searchUtils.js)
//   LLM calls  → Claude via agent-runner.js
//
// TOKEN-SAVING FEATURES BUILT IN:
//   - Qdrant results capped at QDRANT_MAX_CHUNKS (4), low-score chunks dropped
//   - Postgres results cached in memory for static reference tables (1h TTL)
//   - Both are transparent to the agents — no agent code changes needed

import {
  vectorSearch,
  sqlSearch,
  listTables,
  describeTable,
} from "../utils/searchUtils.js";

import {
  QDRANT_MAX_CHUNKS,
  QDRANT_MIN_SCORE,
  POSTGRES_CACHE_TTL_MS,
} from "./model-config.js";

// ── Postgres result cache ─────────────────────────────────────────────────────
// Static reference tables (SDRF norms, shelters, boats, etc.) don't change
// during a disaster response session. Cache their results to avoid re-reading
// the same rows into the LLM context on every query.

// Tables that are effectively read-only — safe to cache
const CACHEABLE_TABLES = new Set([
  "sdmp_table_9_3_sdrf_norms_of_assistance",
  "mcs_equipment",
  "relief_package",
  "shelters_mcs",
  "rescue_boats",
  "health_infrastructure",
  "medical_personnel",
  "telecom_stations",
  "ngos",
  "livestock_shelters",
]);

// In-memory store: cacheKey → { result, expiresAt }
const _postgresCache = new Map();

function _cacheKey(table, whereObj) {
  const sorted = JSON.stringify(
    Object.entries(whereObj ?? {}).sort(([a], [b]) => a.localeCompare(b))
  );
  return `${table}::${sorted}`;
}

function _getCached(table, whereObj) {
  if (!CACHEABLE_TABLES.has(table)) return null;
  const key   = _cacheKey(table, whereObj);
  const entry = _postgresCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _postgresCache.delete(key);
    return null;
  }
  console.log(`[tools] cache HIT  table=${table}`);
  return entry.result;
}

function _setCached(table, whereObj, result) {
  if (!CACHEABLE_TABLES.has(table)) return;
  // Only cache unfiltered (full-table) queries.
  // A filtered result (e.g. block=Brahmagiri) must never be served back for a
  // different filter or an unfiltered query in the same session.
  if (Object.keys(whereObj ?? {}).length > 0) return;
  const key = _cacheKey(table, whereObj);
  _postgresCache.set(key, {
    result,
    expiresAt: Date.now() + POSTGRES_CACHE_TTL_MS,
  });
  console.log(`[tools] cache SET  table=${table}  rows=${result.rowCount}  ttl=1h`);
}

/** Clears the entire Postgres cache — call after any data update or in tests. */
export function clearPostgresCache() {
  _postgresCache.clear();
  console.log("[tools] Postgres cache cleared");
}

// ─────────────────────────────────────────────────────────────────────────────
// search_qdrant
// ─────────────────────────────────────────────────────────────────────────────

// Hard cap on topK passed to Qdrant — prevents agents requesting topK=8
// which then returns 8 chunks before truncation, wasting the Qdrant call.
// Agents should request what they need; this cap is a safety ceiling.
const QDRANT_TOPK_CAP = 4;

export async function executeSearchQdrant(args) {
  const filter = buildQdrantFilter(args);

  // Cap topK at the hard ceiling before the Qdrant call, not after.
  // Previously agents passed topK=8 and we truncated after — this still
  // fetched 8 chunks from Qdrant and serialised them all into tool result JSON
  // before the truncation ran. Capping here saves the serialisation cost too.
  const requestedTopK = Math.min(args.topK ?? 5, QDRANT_TOPK_CAP);

  const hits = await vectorSearch(args.query, {
    topK: requestedTopK,
    filter,
  });

  // Map raw hits to clean result objects
  let results = hits.map((h) => ({
    score:       Number(h.score?.toFixed(4) ?? 0),
    text:        h.payload?.chunk_text ?? h.payload?.text ?? "",
    document:    h.payload?.document_id ?? h.payload?.document_source ?? "unknown",
    section:     h.payload?.section_number ?? h.payload?.section ?? null,
    sectionType: h.payload?.section_type ?? null,
    page:        h.payload?.page_number ?? null,
  }));

  // ── Token saving: drop low-score chunks, cap total chunks ─────────────────
  // Chunks below QDRANT_MIN_SCORE add noise without signal.
  // Cap at QDRANT_MAX_CHUNKS to prevent large tool results bloating the context.
  const beforeCount = results.length;
  results = results
    .filter((r) => r.score >= QDRANT_MIN_SCORE)
    .slice(0, QDRANT_MAX_CHUNKS);

  if (results.length < beforeCount) {
    console.log(
      `[tools] qdrant truncated: ${beforeCount} → ${results.length} chunks` +
      ` (min_score=${QDRANT_MIN_SCORE}, max=${QDRANT_MAX_CHUNKS})`
    );
  }

  const avgScore =
    results.length === 0
      ? 0
      : Number((results.reduce((s, r) => s + r.score, 0) / results.length).toFixed(4));

  return {
    query:       args.query,
    resultCount: results.length,
    results,
    avgScore,
    topScore: results[0]?.score ?? 0,
  };
}

export const searchQdrant = {
  description:
    "Semantic search over disaster-management document chunks (SDMP, DDMPs, " +
    "after-action reports, situation reports). Use for narrative questions about " +
    "procedures, SOPs, historical events, or anything in document prose. " +
    "Returns top-K chunks with text, source document, section, and relevance score.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language search query. Pass the user's full question verbatim.",
      },
      topK: {
        type: "integer",
        description: "Number of chunks to retrieve. Default 5, max 15.",
      },
      documentId: {
        type: "string",
        description: "Optional. Restrict to one document e.g. 'Odisha_SDMP_2019'.",
      },
      documentRole: {
        type: "string",
        enum: ["framework", "evaluation_ground_truth", "after_action", "any"],
        description: "'framework' for SOPs/plans. 'any' for all documents.",
      },
      asOf: {
        type: "string",
        description: "Optional ISO date YYYY-MM-DD for temporal filtering.",
      },
      accessPolicy: {
        type: "string",
        enum: ["public", "operator_only", "any"],
        description: "Use 'any' for operator queries.",
      },
    },
    required: ["query"],
  },
  execute: executeSearchQdrant,
};

// ─────────────────────────────────────────────────────────────────────────────
// query_postgres
// ─────────────────────────────────────────────────────────────────────────────

// Per-table hard row limits — prevents agents accidentally fetching entire
// large tables into context. Small tables (≤12 rows) are uncapped.
// shelters_mcs (182 rows) and ngos (57 rows) are the main offenders.
const TABLE_ROW_LIMITS = {
  shelters_mcs: 25,   // always filter by block — 25 is a safe ceiling for one block
  ngos:         60,   // one block has ≤10 NGOs; 60 is the safe district-wide max
  relief_package: 20,
};
const DEFAULT_ROW_LIMIT = 50;
const MAX_ROW_LIMIT     = 100; // hard ceiling regardless of what the agent requests

export async function executeQueryPostgres(args) {
  // Normalise the where clause to a plain object
  let whereObj = {};
  if (Array.isArray(args.where)) {
    whereObj = Object.fromEntries(
      args.where.map(({ column, value }) => [column, value])
    );
  } else if (args.where && typeof args.where === "object") {
    whereObj = args.where;
  }

  // Enforce per-table row limit
  const tableLimit   = TABLE_ROW_LIMITS[args.table] ?? DEFAULT_ROW_LIMIT;
  const requestedLim = args.limit ?? tableLimit;
  const effectiveLim = Math.min(requestedLim, tableLimit, MAX_ROW_LIMIT);

  if (effectiveLim < (args.limit ?? tableLimit)) {
    console.log(`[tools] postgres row limit capped: ${args.table} → ${effectiveLim} rows`);
  }

  // ── Cache check ───────────────────────────────────────────────────────────
  const cached = _getCached(args.table, whereObj);
  if (cached) return cached;

  const result = await sqlSearch(args.table, {
    columns:  args.columns?.length > 0 ? args.columns : ["*"],
    where:    whereObj,
    orderBy:  args.orderBy  ?? undefined,
    orderDir: args.orderDir ?? "ASC",
    limit:    effectiveLim,
  });

  const out = {
    table:    result.table,
    sql:      result.sql,
    rowCount: result.rows.length,
    rows:     result.rows,
  };

  // ── Cache set ─────────────────────────────────────────────────────────────
  _setCached(args.table, whereObj, out);

  return out;
}

export const queryPostgres = {
  description:
    "Structured lookup against data tables. Use for exact values, counts, and lists. " +
    "Available tables: shelters_mcs, rescue_boats, health_infrastructure, " +
    "medical_personnel, telecom_stations, ngos, mcs_equipment, " +
    "sdmp_table_9_3_sdrf_norms_of_assistance, relief_package, livestock_shelters. " +
    "Call list_tables first if unsure of the table name.",
  input_schema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Exact table name.",
      },
      columns: {
        type: "array",
        items: { type: "string" },
        description: "Columns to return. Empty array returns all columns.",
      },
      where: {
        type: "array",
        description: "Row filters as [{column, value}] pairs. Pass [] for no filter (all rows).",
        items: {
          type: "object",
          properties: {
            column: { type: "string" },
            value:  { type: "string" },
          },
          required: ["column", "value"],
        },
      },
      orderBy: {
        type: "string",
        description: "Column to sort by.",
      },
      orderDir: {
        type: "string",
        enum: ["ASC", "DESC"],
      },
      limit: {
        type: "integer",
        description: "Max rows to return. Default 50, max 500.",
      },
    },
    required: ["table"],
  },
  execute: executeQueryPostgres,
};

// ─────────────────────────────────────────────────────────────────────────────
// list_tables
// ─────────────────────────────────────────────────────────────────────────────

export async function executeListTables() {
  const tables = await listTables();
  return { tableCount: tables.length, tables };
}

export const listTablesTool = {
  description: "List all available data tables. Call before query_postgres if unsure which table to use.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  execute: executeListTables,
};

// ─────────────────────────────────────────────────────────────────────────────
// describe_table
// ─────────────────────────────────────────────────────────────────────────────

export async function executeDescribeTable(args) {
  return await describeTable(args.table);
}

export const describeTableTool = {
  description: "Get column names and types for a table. Call between list_tables and query_postgres.",
  input_schema: {
    type: "object",
    properties: {
      table: {
        type: "string",
        description: "Exact table name from list_tables.",
      },
    },
    required: ["table"],
  },
  execute: executeDescribeTable,
};

// ─────────────────────────────────────────────────────────────────────────────
// Tool bundles — passed to createAgent() in each agent file
// ─────────────────────────────────────────────────────────────────────────────

export const disasterResponseTools = {
  search_qdrant:  searchQdrant,
  query_postgres: queryPostgres,
  list_tables:    listTablesTool,
  describe_table: describeTableTool,
};

export const preparednessTools = {
  search_qdrant:  searchQdrant,
  query_postgres: queryPostgres,
  list_tables:    listTablesTool,
  describe_table: describeTableTool,
};

export const reliefFinanceTools = {
  query_postgres: queryPostgres,
  list_tables:    listTablesTool,
  describe_table: describeTableTool,
  search_qdrant:  searchQdrant,
};

export const resourceAllocationTools = {
  list_tables:    listTablesTool,
  describe_table: describeTableTool,
  search_qdrant:  searchQdrant,
  query_postgres: queryPostgres,
};

// ─────────────────────────────────────────────────────────────────────────────
// Session-level temporal constraint
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS:
//   The as_of date arrives in query.js and is appended to the user message as a
//   text tag — [EVALUATION MODE: as_of=YYYY-MM-DD]. Agents are instructed to
//   respect it via their system prompts, but they never pass asOf to search_qdrant
//   tool calls. This means buildQdrantFilter() never receives the date and the
//   temporal filter never fires at the Qdrant layer.
//
//   The fix: query.js calls setSessionAsOf(as_of) before running the agent
//   pipeline. buildQdrantFilter() then reads _sessionAsOf as a fallback when
//   the agent does not pass asOf explicitly. This enforces the filter at the
//   infrastructure layer regardless of agent behaviour.
//
// WHY mustNot on evaluation_ground_truth (not a date range):
//   SDMP and DDMP chunks have no valid_as_of set. A Qdrant range filter on a
//   missing field excludes those points — which would block the planning
//   documents the system actually needs to answer pre-event queries.
//   The correct mechanism is mustNot on document_role=evaluation_ground_truth,
//   which blocks only Fani JRNA and UNICEF SitRep chunks (both tagged
//   evaluation_ground_truth during ingestion) without touching planning docs.

let _sessionAsOf = null;

/**
 * Sets the session-level temporal constraint.
 * Call this from query.js before invoking runWithCRAG() when as_of is present.
 * @param {string|null} asOf - ISO date string e.g. "2019-05-02", or null to clear
 */
export function setSessionAsOf(asOf) {
  _sessionAsOf = asOf ?? null;
  if (asOf) {
    console.log(`[tools] session asOf set → ${asOf} (evaluation_ground_truth chunks will be blocked)`);
  } else {
    console.log(`[tools] session asOf cleared`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildQdrantFilter(args) {
  const must    = [];
  const mustNot = [];

  if (args.documentId) {
    must.push({ key: "document_id", match: { value: args.documentId } });
  }
  if (args.documentRole && args.documentRole !== "any") {
    must.push({ key: "document_role", match: { value: args.documentRole } });
  }
  if (args.accessPolicy === "public") {
    must.push({ key: "access_policy", match: { value: "public" } });
  } else if (args.accessPolicy === "operator_only") {
    must.push({ key: "access_policy", match: { value: "operator_only" } });
  }

  // Temporal filter — use session value as fallback when agent does not pass asOf.
  // Uses mustNot on evaluation_ground_truth rather than a date range because
  // planning docs (SDMP, DDMP) have no valid_as_of set and would be excluded
  // by a range filter, breaking pre-event SOP retrieval.
  const effectiveAsOf = args.asOf ?? _sessionAsOf;
  if (effectiveAsOf) {
    mustNot.push({ key: "document_role", match: { value: "evaluation_ground_truth" } });
  }

  const filter = {};
  if (must.length    > 0) filter.must     = must;
  if (mustNot.length > 0) filter.must_not = mustNot;
  return Object.keys(filter).length > 0 ? filter : null;
}