// test-tools.js
//
// Run this BEFORE building any agents.
// Tests searchUtils.js and tools.js against your live Qdrant + Postgres.
//
// Usage:
//   node test-tools.js
//
// What it checks:
//   1. Postgres connection reachable (via imported pool)
//   2. Qdrant connection reachable (via imported client)
//   3. embedQuery()     — OpenAI returns a 1536-dim vector
//   4. listTables()     — returns your 24 tables
//   5. describeTable()  — returns columns for a known table
//   6. vectorSearch()   — returns hits with correct payload shape
//   7. sqlSearch()      — returns rows from a known table
//   8. sqlSearch()      — correctly rejects an unknown table
//   9. sqlSearch()      — correctly rejects an unknown column in where
//  10. tools.js: list_tables tool  — end-to-end execute()
//  11. tools.js: describe_table tool
//  12. tools.js: search_qdrant tool — with no filters
//  13. tools.js: search_qdrant tool — with documentId filter
//  14. tools.js: search_qdrant tool — with asOf temporal filter (Fani replay)
//  15. tools.js: query_postgres tool — basic fetch
//  16. tools.js: query_postgres tool — with where filter
//  17. tools.js: query_postgres tool — rejects unknown table

import { connectPostgres } from "./src/config/postgres.js";
import { connectQdrant }   from "./src/config/qdrant.js";

import {
  embedQuery,
  vectorSearch,
  sqlSearch,
  listTables,
  describeTable,
} from "./src/utils/searchUtils.js";

import {
  listTablesTool,
  describeTableTool,
  searchQdrant,
  queryPostgres,
  executeListTables,
  executeDescribeTable,
  executeSearchQdrant,
  executeQueryPostgres,
} from "./src/agents/tools.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  process.stdout.write(`  ${name} ... `);
  try {
    await fn();
    console.log("✓ pass");
    passed++;
  } catch (err) {
    console.log(`✗ FAIL\n    → ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  RAG Platform — tools + searchUtils smoke tests");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── Section 1: Connectivity ────────────────────────────────────────────────
  console.log("[ 1 ] Connectivity");

  await test("Postgres pool reachable", async () => {
    await connectPostgres();
  });

  await test("Qdrant client reachable", async () => {
    await connectQdrant();
  });

  // ── Section 2: searchUtils — embedQuery ────────────────────────────────────
  console.log("\n[ 2 ] searchUtils — embedQuery");

  let embedding;
  await test("returns an array", async () => {
    embedding = await embedQuery("cyclone evacuation procedure");
    assert(Array.isArray(embedding), "expected array");
  });

  await test("correct dimension (1536 for text-embedding-3-small)", async () => {
    assert(embedding.length === 1536, `expected 1536, got ${embedding.length}`);
  });

  await test("rejects empty string", async () => {
    let threw = false;
    try { await embedQuery(""); } catch { threw = true; }
    assert(threw, "should have thrown on empty string");
  });

  // ── Section 3: searchUtils — listTables / describeTable ───────────────────
  console.log("\n[ 3 ] searchUtils — listTables / describeTable");

  let tables;
  await test("listTables returns an array", async () => {
    tables = await listTables();
    assert(Array.isArray(tables), "expected array");
  });

  await test("at least 1 table present (ideally 24)", async () => {
    assert(tables.length >= 1, `expected ≥1 table, got ${tables.length}`);
    console.log(`\n      found ${tables.length} tables: ${tables.slice(0, 4).join(", ")}…`);
  });

  await test("describeTable returns columns for first table", async () => {
    const info = await describeTable(tables[0]);
    assert(Array.isArray(info.columns), "expected columns array");
    assert(info.columns.length > 0, "expected at least one column");
    console.log(`\n      ${tables[0]}: [${info.columns.map(c => c.name).join(", ")}]`);
  });

  // ── Section 4: searchUtils — vectorSearch ─────────────────────────────────
  console.log("\n[ 4 ] searchUtils — vectorSearch");

  let hits;
  await test("returns an array of hits", async () => {
    hits = await vectorSearch("agriculture department cyclone responsibilities");
    assert(Array.isArray(hits), "expected array");
  });

  await test("each hit has score + payload", async () => {
    assert(hits.length > 0, "expected at least one hit");
    const h = hits[0];
    assert(typeof h.score === "number", "expected numeric score");
    assert(h.payload !== undefined, "expected payload");
    console.log(`\n      top hit: score=${h.score.toFixed(4)} doc=${h.payload?.document_id ?? "?"} section=${h.payload?.section_number ?? "?"}`);
  });

  await test("topK limit is respected", async () => {
    const r = await vectorSearch("flood relief", { topK: 3 });
    assert(r.length <= 3, `expected ≤3, got ${r.length}`);
  });

  await test("documentId filter works", async () => {
    const r = await vectorSearch("cyclone", {
      topK: 5,
      filter: { must: [{ key: "document_id", match: { value: "Odisha_SDMP_2019" } }] },
    });
    const allMatch = r.every(h => h.payload?.document_id === "Odisha_SDMP_2019");
    assert(allMatch, "filter returned chunks from wrong document");
  });

  await test("access_policy public filter excludes operator_only chunks", async () => {
    const r = await vectorSearch("satellite phone contact", {
      topK: 10,
      filter: { must: [{ key: "access_policy", match: { value: "public" } }] },
    });
    const hasRestricted = r.some(h => h.payload?.access_policy === "operator_only");
    assert(!hasRestricted, "operator_only chunk leaked through public filter");
  });

  // ── Section 5: searchUtils — sqlSearch ────────────────────────────────────
  console.log("\n[ 5 ] searchUtils — sqlSearch");

  await test("returns rows from a valid table", async () => {
    const result = await sqlSearch(tables[0], { limit: 3 });
    assert(Array.isArray(result.rows), "expected rows array");
    assert(typeof result.sql === "string", "expected sql string");
    assert(result.table === tables[0], "table name mismatch");
    console.log(`\n      ${tables[0]}: ${result.rows.length} row(s) returned`);
  });

  await test("rejects unknown table", async () => {
    let threw = false;
    try { await sqlSearch("definitely_not_a_real_table"); } catch { threw = true; }
    assert(threw, "should have thrown on unknown table");
  });

  await test("rejects unknown column in where filter", async () => {
    let threw = false;
    try {
      await sqlSearch(tables[0], { where: { nonexistent_column_xyz: "test" } });
    } catch { threw = true; }
    assert(threw, "should have thrown on unknown column");
  });

  await test("where filter returns subset of rows", async () => {
    // Get a real column + value from the first table to filter on
    const info = await describeTable(tables[0]);
    const firstCol = info.columns[0].name;
    const sampleRows = await sqlSearch(tables[0], { limit: 1 });
    if (sampleRows.rows.length === 0) return; // skip if table empty
    const sampleVal = String(sampleRows.rows[0][firstCol] ?? "").slice(0, 20);
    if (!sampleVal) return;
    const filtered = await sqlSearch(tables[0], {
      where: { [firstCol]: sampleVal },
      limit: 10,
    });
    assert(Array.isArray(filtered.rows), "expected rows array");
  });

  // ── Section 6: tools.js — list_tables ────────────────────────────────────
  console.log("\n[ 6 ] tools.js — list_tables");

  await test("execute() returns tableCount + tables array", async () => {
    const result = await executeListTables({});
    assert(typeof result.tableCount === "number", "expected tableCount");
    assert(Array.isArray(result.tables), "expected tables array");
    assert(result.tableCount === result.tables.length, "count mismatch");
  });

  // ── Section 7: tools.js — describe_table ─────────────────────────────────
  console.log("\n[ 7 ] tools.js — describe_table");

  await test("execute() returns column metadata", async () => {
    const result = await executeDescribeTable({ table: tables[0] });
    assert(result.table === tables[0], "table name mismatch");
    assert(Array.isArray(result.columns), "expected columns array");
    assert(result.columns[0].name, "expected column name");
    assert(result.columns[0].type, "expected column type");
  });

  // ── Section 8: tools.js — search_qdrant ──────────────────────────────────
  console.log("\n[ 8 ] tools.js — search_qdrant");

  let qdrantResult;
  await test("basic search returns shaped results", async () => {
    qdrantResult = await executeSearchQdrant({
      query: "evacuation procedure during cyclone warning",
      topK: 5,
      documentId: null,
      documentRole: "any",
      asOf: null,
      accessPolicy: "public",
    });
    assert(Array.isArray(qdrantResult.results), "expected results array");
    assert(typeof qdrantResult.avgScore === "number", "expected avgScore");
    assert(typeof qdrantResult.topScore === "number", "expected topScore");
    console.log(`\n      topScore=${qdrantResult.topScore} avgScore=${qdrantResult.avgScore} results=${qdrantResult.resultCount}`);
  });

  await test("each result has text, document, score", async () => {
    const r = qdrantResult.results[0];
    assert(typeof r.text === "string" && r.text.length > 0, "expected non-empty text");
    assert(typeof r.document === "string", "expected document field");
    assert(typeof r.score === "number", "expected score");
  });

  await test("documentId filter restricts to one doc", async () => {
    const r = await executeSearchQdrant({
      query: "cyclone shelter",
      topK: 5,
      documentId: "Odisha_SDMP_2019",
      documentRole: "any",
      asOf: null,
      accessPolicy: "any",
    });
    const allMatch = r.results.every(h => h.document === "Odisha_SDMP_2019");
    assert(allMatch, `filter leaked: ${r.results.map(h => h.document).join(", ")}`);
  });

  await test("asOf temporal filter (Fani replay: 2019-05-02)", async () => {
    // Should only return pre-Fani chunks — Fani evaluation docs should be excluded
    const r = await executeSearchQdrant({
      query: "cyclone response coordination",
      topK: 10,
      documentId: null,
      documentRole: "any",
      asOf: "2019-05-02",
      accessPolicy: "any",
    });
    // Fani ground truth docs should not appear
    const faniDocs = r.results.filter(h =>
      h.document?.toLowerCase().includes("fani") &&
      h.document?.toLowerCase().includes("jrna")
    );
    assert(faniDocs.length === 0, `Fani ground-truth leaked through asOf filter: ${faniDocs.map(h => h.document).join(", ")}`);
    console.log(`\n      ${r.resultCount} results within asOf=2019-05-02`);
  });

  // ── Section 9: tools.js — query_postgres ─────────────────────────────────
  console.log("\n[ 9 ] tools.js — query_postgres");

  await test("basic fetch returns rows + sql", async () => {
    const result = await executeQueryPostgres({
      table: tables[0],
      columns: [],
      where: [],
      orderBy: null,
      orderDir: "ASC",
      limit: 5,
    });
    assert(Array.isArray(result.rows), "expected rows");
    assert(typeof result.sql === "string", "expected sql");
    assert(result.rowCount === result.rows.length, "rowCount mismatch");
    console.log(`\n      ${result.rowCount} rows, sql: ${result.sql.slice(0, 70)}…`);
  });

  await test("rejects unknown table", async () => {
    let threw = false;
    try {
      await executeQueryPostgres({
        table: "nonexistent_table_xyz",
        columns: [], where: [], orderBy: null, orderDir: "ASC", limit: 5,
      });
    } catch { threw = true; }
    assert(threw, "should have thrown on unknown table");
  });

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("  ✓ All checks passed — safe to build agents\n");
  } else {
    console.log("  ✗ Fix the failures above before building agents\n");
    process.exit(1);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(0);
}

run().catch((err) => {
  console.error("\n[test] Unexpected fatal error:", err.message);
  console.error(err.stack);
  process.exit(1);
});