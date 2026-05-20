// src/ingestion/validate.js
//
// Stage 4 — Smoke test validator.
// Confirms that chunking + embedding + ingestion all worked correctly.
//
// Usage:
//   node src/ingestion/validate.js
//
// Runs 4 smoke test queries from the chunking recipe:
//   1. Agriculture Dept cyclone responsibilities → expect Qdrant §6.3.1
//   2. Seismic Zone-III districts               → expect SQL result > 0 rows
//   3. Ex-gratia for disaster death             → expect SQL result with amount
//   4. Who chairs State Executive Committee     → expect Qdrant Ch III chunk
//
// Prints PASS / FAIL for each test with retrieved content preview.
//
// Requirements: npm install openai @qdrant/js-client-rest pg dotenv

import "dotenv/config";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import pg from "pg";

// ── Config ────────────────────────────────────────────────────────────────────

const COLLECTION  = process.env.QDRANT_COLLECTION || "sdmp_chunks";
const EMBED_MODEL = "text-embedding-3-small";
const TOP_K       = 5;   // how many Qdrant results to fetch per query

// ── Clients ───────────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const qdrant = new QdrantClient({
  host: process.env.QDRANT_HOST || "localhost",
  port: Number(process.env.QDRANT_PORT) || 6333,
});

const pgPool = new pg.Pool({
  host:     process.env.POSTGRES_HOST     || "localhost",
  port:     Number(process.env.POSTGRES_PORT) || 5432,
  database: process.env.POSTGRES_DB       || "sdmp",
  user:     process.env.POSTGRES_USER     || "postgres",
  password: process.env.POSTGRES_PASSWORD,
  max: 3,
  connectionTimeoutMillis: 5_000,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function embedQuery(text) {
  const res = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return res.data[0].embedding;
}

async function searchQdrant(query, filter = null) {
  const vector = await embedQuery(query);
  const params = {
    vector,
    limit: TOP_K,
    with_payload: true,
    with_vector:  false,
  };
  if (filter) params.filter = filter;

  const results = await qdrant.search(COLLECTION, params);
  return results;
}

async function queryPostgres(sql, params = []) {
  const client = await pgPool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// Pretty-print a Qdrant result
function printQdrantResult(hit, rank) {
  const p = hit.payload;
  console.log(`  ${rank}. score=${hit.score.toFixed(4)}  chapter=${p.chapter}  section=${p.section_number ?? "—"}  type=${p.section_type}`);
  console.log(`     title: ${p.section_title ?? "—"}`);
  console.log(`     dept:  ${p.department ?? "—"}`);
  console.log(`     preview: "${p.chunk_text.slice(0, 120).replace(/\n/g, " ")}…"`);
}

// ── Smoke tests ───────────────────────────────────────────────────────────────

const TESTS = [

  // ── Test 1: Agriculture Dept SOP ─────────────────────────────────────────
  {
    id: 1,
    label: "Agriculture Dept cyclone responsibilities",
    query: "What are the responsibilities of the Agriculture Department during a cyclone?",
    type: "vector",
    pass: (results) => {
      // PASS if the top result is from Ch VI section 6.3.1
      const top = results[0];
      return (
        top?.payload?.chapter === "VI" &&
        top?.payload?.section_number === "6.3.1" &&
        top?.score > 0.5
      );
    },
    hint: "Expected: Ch VI §6.3.1, section_type=sop, department=agriculture",
  },

  // ── Test 2: Seismic Zone-III districts ────────────────────────────────────
  {
    id: 2,
    label: "Seismic Zone-III districts count",
    query: "How many districts come under seismic Zone-III in Odisha?",
    type: "hybrid",   // vector should surface the table card; SQL gives the answer
    vectorPass: (results) => {
      // PASS if any top-3 result is the table card for seismic zones
      return results.some(
        (r) =>
          r.payload?.section_type === "table_summary" &&
          r.payload?.sql_table_name === "sdmp_table_2_5_seismic_zones_by_district"
      );
    },
    sql: `SELECT seismic_zone, COUNT(*) AS district_count
          FROM sdmp_table_2_5_seismic_zones_by_district
          GROUP BY seismic_zone
          ORDER BY seismic_zone`,
    sqlPass: (rows) => {
      // PASS if we get rows back and Zone III has > 0 districts
      return rows.length > 0 && rows.some(
        (r) => r.seismic_zone?.toUpperCase().includes("III") && Number(r.district_count) > 0
      );
    },
    hint: "Expected: table card for sdmp_table_2_5 in top-3; SQL returns Zone III count",
  },

  // ── Test 3: Ex-gratia for disaster death ─────────────────────────────────
  {
    id: 3,
    label: "Ex-gratia amount for disaster death",
    query: "What is the ex-gratia for a disaster-related death in Odisha?",
    type: "hybrid",
    vectorPass: (results) => {
      // PASS if any top-3 result is the table card for SDRF norms
      return results.some(
        (r) =>
          r.payload?.section_type === "table_summary" &&
          r.payload?.sql_table_name === "sdmp_table_9_3_sdrf_norms_of_assistance"
      );
    },
    sql: `SELECT * FROM sdmp_table_9_3_sdrf_norms_of_assistance
          WHERE LOWER(item) LIKE '%death%'
             OR LOWER(item) LIKE '%deceased%'
             OR LOWER(category) LIKE '%death%'
             OR LOWER(category) LIKE '%ex-gratia%'
          LIMIT 5`,
    sqlPass: (rows) => rows.length > 0,
    hint: "Expected: table card for sdmp_table_9_3 in top-3; SQL returns ex-gratia row",
  },

  // ── Test 4: Who chairs State Executive Committee ──────────────────────────
  {
    id: 4,
    label: "Who chairs the State Executive Committee",
    query: "Who chairs the State Executive Committee in Odisha?",
    type: "vector",
    pass: (results) => {
      // PASS if ANY top-5 result is from Ch III and mentions Chief Secretary + SEC
      // The exact chunk (3.1.4) may not be rank-1 but should be in top-5
      return results.some(
        (r) =>
          r.payload?.chapter === "III" &&
          r.score > 0.4 &&
          (
            r.payload?.chunk_text?.toLowerCase().includes("chief secretary") ||
            r.payload?.chunk_text?.toLowerCase().includes("state executive committee")
          )
      );
    },
    hint: "Expected: Ch III institutional chunk mentioning Chief Secretary in top-5",
  },

];

// ── Runner ────────────────────────────────────────────────────────────────────

async function runTest(test) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Test ${test.id}: ${test.label}`);
  console.log(`Query: "${test.query}"`);
  console.log(`${"─".repeat(60)}`);

  let passed = true;
  const failures = [];

  // ── Vector search ─────────────────────────────────────────────────────────
  console.log(`\n[qdrant] Top ${TOP_K} results:`);
  let qdrantResults = [];
  try {
    qdrantResults = await searchQdrant(test.query);
    qdrantResults.forEach((r, i) => printQdrantResult(r, i + 1));
  } catch (err) {
    console.error(`  ERROR: ${err.message}`);
    failures.push(`Qdrant search failed: ${err.message}`);
    passed = false;
  }

  // ── Vector pass check ─────────────────────────────────────────────────────
  if (test.type === "vector") {
    const vectorPassed = test.pass(qdrantResults);
    if (!vectorPassed) {
      passed = false;
      failures.push(`Vector retrieval miss — ${test.hint}`);
    }
  } else if (test.type === "hybrid") {
    const vectorPassed = test.vectorPass(qdrantResults);
    if (!vectorPassed) {
      passed = false;
      failures.push(`Table card not in top-${TOP_K} — ${test.hint}`);
    }
  }

  // ── SQL check (hybrid tests only) ────────────────────────────────────────
  if (test.sql) {
    console.log(`\n[postgres] SQL: ${test.sql.trim().split("\n")[0]}…`);
    let rows = [];
    try {
      rows = await queryPostgres(test.sql);
      console.log(`[postgres] ${rows.length} row(s) returned:`);
      rows.forEach((r) => console.log(`  ${JSON.stringify(r)}`));
    } catch (err) {
      console.error(`  ERROR: ${err.message}`);
      failures.push(`SQL query failed: ${err.message}`);
      passed = false;
    }

    if (rows.length > 0) {
      const sqlPassed = test.sqlPass(rows);
      if (!sqlPassed) {
        passed = false;
        failures.push(`SQL result did not match expected — ${test.hint}`);
      }
    } else {
      passed = false;
      failures.push(`SQL returned 0 rows — table may not be loaded`);
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────
  if (passed) {
    console.log(`\n✅ PASS — Test ${test.id}: ${test.label}`);
  } else {
    console.log(`\n❌ FAIL — Test ${test.id}: ${test.label}`);
    failures.forEach((f) => console.log(`   → ${f}`));
  }

  return { id: test.id, label: test.label, passed, failures };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SDMP RAG — Ingestion Smoke Tests`);
  console.log(`  Model : ${EMBED_MODEL}`);
  console.log(`  Qdrant: ${process.env.QDRANT_HOST || "localhost"}:${process.env.QDRANT_PORT || 6333} / ${COLLECTION}`);
  console.log(`  PG    : ${process.env.POSTGRES_HOST || "localhost"}:${process.env.POSTGRES_PORT || 5432} / ${process.env.POSTGRES_DB || "sdmp"}`);
  console.log(`${"═".repeat(60)}`);

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set in .env");
  }

  const results = [];
  for (const test of TESTS) {
    const result = await runTest(test);
    results.push(result);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Results: ${passed}/${results.length} passed`);
  results.forEach((r) => {
    const icon = r.passed ? "✅" : "❌";
    console.log(`  ${icon} Test ${r.id}: ${r.label}`);
  });
  console.log(`${"═".repeat(60)}\n`);

  if (failed > 0) {
    console.log(`⚠  ${failed} test(s) failed. Fix before building the query layer.`);
    console.log(`   Common causes:`);
    console.log(`   - Qdrant collection empty → re-run embedder.js`);
    console.log(`   - Postgres table missing  → re-run ingest-csv.js`);
    console.log(`   - Wrong section_type tag  → check chunker.js metadata`);
    process.exitCode = 1;
  } else {
    console.log(`✅ All tests passed. Ready for Stage 5 — query router.`);
  }

  await pgPool.end();
}

main().catch((err) => {
  console.error("[validate] Fatal:", err.message);
  process.exit(1);
});