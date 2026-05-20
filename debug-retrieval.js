// debug-retrieval.js
//
// Runs the three failing queries directly through the tools (bypassing the agent)
// to see exactly what Qdrant and Postgres are returning.
// This tells us whether the problem is in retrieval or in the agent's query construction.
//
// Usage:
//   node debug-retrieval.js

import { connectPostgres } from "./src/config/postgres.js";
import { connectQdrant }   from "./src/config/qdrant.js";
import { executeSearchQdrant, executeQueryPostgres, executeListTables } from "./src/agents/tools.js";
import { vectorSearch } from "./src/utils/searchUtils.js";

async function run() {
  await connectPostgres();
  await connectQdrant();

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Retrieval Debug");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // ── DEBUG 1: Agriculture SOP ──────────────────────────────────────────────
  // Smoke test got 0.62 for this query. Agent got 0.27.
  // Check: does access_policy=public filter it out?
  console.log("[ 1 ] Agriculture Dept SOP — isolating the access_policy issue\n");

  console.log("  1a. Raw search (no filters) — should score ~0.62:");
  const raw = await vectorSearch(
    "What should the Agriculture Department do during a Very Severe Cyclone warning?",
    { topK: 3 }
  );
  raw.forEach((h, i) => {
    console.log(`       [${i+1}] score=${h.score.toFixed(4)} doc=${h.payload?.document_id} section=${h.payload?.section_number} access=${h.payload?.access_policy}`);
  });

  console.log("\n  1b. With accessPolicy=public (what the agent uses for 'operator' role — bug?):");
  const withPublic = await executeSearchQdrant({
    query: "What should the Agriculture Department do during a Very Severe Cyclone warning?",
    topK: 3, documentId: null, documentRole: "any", asOf: null, accessPolicy: "public",
  });
  withPublic.results.forEach((h, i) => {
    console.log(`       [${i+1}] score=${h.score} doc=${h.document} section=${h.section}`);
  });
  console.log(`       topScore=${withPublic.topScore} avgScore=${withPublic.avgScore}`);

  console.log("\n  1c. With accessPolicy=any (correct for operator role):");
  const withAny = await executeSearchQdrant({
    query: "What should the Agriculture Department do during a Very Severe Cyclone warning?",
    topK: 3, documentId: null, documentRole: "any", asOf: null, accessPolicy: "any",
  });
  withAny.results.forEach((h, i) => {
    console.log(`       [${i+1}] score=${h.score} doc=${h.document} section=${h.section}`);
  });
  console.log(`       topScore=${withAny.topScore} avgScore=${withAny.avgScore}`);

  console.log("\n  1d. Original smoke test query (exact string):");
  const smokeQuery = await vectorSearch(
    "agriculture department cyclone responsibilities",
    { topK: 3 }
  );
  smokeQuery.forEach((h, i) => {
    console.log(`       [${i+1}] score=${h.score.toFixed(4)} doc=${h.payload?.document_id} section=${h.payload?.section_number} access=${h.payload?.access_policy}`);
  });

  // ── DEBUG 2: Ex-gratia amount ─────────────────────────────────────────────
  console.log("\n[ 2 ] Ex-gratia — finding the right table and column names\n");

  const tables = await executeListTables({});
  const sdmpTables = tables.tables.filter(t =>
    t.includes("sdrf") || t.includes("sdmp_table_9") || t.includes("assistance") || t.includes("exgratia") || t.includes("relief")
  );
  console.log("  SDRF-related tables found:", sdmpTables.length > 0 ? sdmpTables : "NONE");
  console.log("  All tables:", tables.tables.join(", "));

  // Try querying each candidate table
  for (const t of sdmpTables.slice(0, 3)) {
    console.log(`\n  Querying ${t} (first 5 rows):`);
    try {
      const r = await executeQueryPostgres({
        table: t, columns: [], where: [], orderBy: null, orderDir: "ASC", limit: 5,
      });
      console.log(`    rows=${r.rowCount}, sql=${r.sql}`);
      if (r.rows.length > 0) console.log("    sample:", JSON.stringify(r.rows[0]));
    } catch(e) {
      console.log("    ERROR:", e.message);
    }
  }

  // Also try the exact table name from the chunking recipe
  const sdmpTable93 = "sdmp_table_9_3_sdrf_norms_of_assistance";
  if (tables.tables.includes(sdmpTable93)) {
    console.log(`\n  Direct query on ${sdmpTable93}:`);
    const r = await executeQueryPostgres({
      table: sdmpTable93, columns: [], where: [], orderBy: null, orderDir: "ASC", limit: 5,
    });
    console.log(`    rows=${r.rowCount}`);
    if (r.rows.length > 0) console.log("    columns:", Object.keys(r.rows[0]).join(", "));
    if (r.rows.length > 0) console.log("    sample:", JSON.stringify(r.rows[0]));
  } else {
    console.log(`\n  ⚠ Table '${sdmpTable93}' NOT found in Postgres`);
    console.log("  Closest match:", tables.tables.find(t => t.includes("9")) ?? "none");
  }

  // ── DEBUG 3: Fani replay — asOf filter too aggressive? ───────────────────
  console.log("\n[ 3 ] Fani replay asOf filter — checking valid_as_of payload values\n");

  console.log("  3a. No asOf filter — what do coordination/failure queries return?");
  const noAsOf = await vectorSearch(
    "cyclone response coordination failures lessons learned",
    { topK: 5 }
  );
  noAsOf.forEach((h, i) => {
    console.log(`       [${i+1}] score=${h.score.toFixed(4)} doc=${h.payload?.document_id} valid_as_of=${h.payload?.valid_as_of ?? "NULL"} role=${h.payload?.document_role}`);
  });

  console.log("\n  3b. With asOf=2019-05-02 — what survives the filter?");
  const withAsOf = await executeSearchQdrant({
    query: "cyclone response coordination failures",
    topK: 10, documentId: null, documentRole: "any", asOf: "2019-05-02", accessPolicy: "any",
  });
  console.log(`    results=${withAsOf.resultCount} topScore=${withAsOf.topScore}`);
  withAsOf.results.slice(0, 3).forEach((h, i) => {
    console.log(`       [${i+1}] score=${h.score} doc=${h.document} section=${h.section}`);
  });

  console.log("\n  3c. SDMP chunks only — do they have valid_as_of set?");
  const sdmpChunks = await vectorSearch(
    "cyclone coordination",
    { topK: 5, filter: { must: [{ key: "document_id", match: { value: "Odisha_SDMP_2019" } }] } }
  );
  sdmpChunks.forEach((h, i) => {
    console.log(`       [${i+1}] valid_as_of=${h.payload?.valid_as_of ?? "NULL"} doc_role=${h.payload?.document_role}`);
  });

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});