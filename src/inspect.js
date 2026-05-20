// src/inspect.js
// Run: node src/inspect.js
// Checks Qdrant, Postgres, and query API health in one shot.

import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";
import pg from "pg";
import OpenAI from "openai";

const COLLECTION = process.env.QDRANT_COLLECTION || "sdmp_chunks";

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

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function pad(str, n) { return String(str).padEnd(n); }
function rpad(str, n) { return String(str).padStart(n); }

// ── 1. Qdrant Inspection ──────────────────────────────────────────────────────

async function inspectQdrant() {
  console.log("\n" + "═".repeat(60));
  console.log("  QDRANT");
  console.log("═".repeat(60));

  const col = await qdrant.getCollection(COLLECTION);
  console.log(`Collection    : ${COLLECTION}`);
  console.log(`Total points  : ${col.points_count}`);
  console.log(`Vector size   : ${col.config?.params?.vectors?.size}`);
  console.log(`Distance      : ${col.config?.params?.vectors?.distance}`);

  // Scroll through all points and count by document_id
  const docCounts = {};
  const roleCounts = {};
  let offset = null;
  let total = 0;

  do {
    const result = await qdrant.scroll(COLLECTION, {
      limit: 200,
      offset,
      with_payload: ["document_id", "document_role", "section_type", "chunk_type"],
      with_vector: false,
    });
    for (const point of result.points) {
      const docId   = point.payload?.document_id || "unknown";
      const role    = point.payload?.document_role || "unknown";
      const type    = point.payload?.section_type || point.payload?.chunk_type || "unknown";
      docCounts[docId] = (docCounts[docId] || 0) + 1;
      roleCounts[role] = (roleCounts[role] || 0) + 1;
      total++;
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  console.log(`\nBy document_id:`);
  for (const [doc, count] of Object.entries(docCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${pad(doc, 45)} ${rpad(count, 4)} points`);
  }

  console.log(`\nBy document_role:`);
  for (const [role, count] of Object.entries(roleCounts).sort((a,b) => b[1]-a[1])) {
    console.log(`  ${pad(role, 35)} ${rpad(count, 4)} points`);
  }
}

// ── 2. Postgres Inspection ────────────────────────────────────────────────────

async function inspectPostgres() {
  console.log("\n" + "═".repeat(60));
  console.log("  POSTGRES");
  console.log("═".repeat(60));

  const client = await pgPool.connect();
  try {
    const { rows: db } = await client.query(
      "SELECT current_database() AS db, version() AS ver"
    );
    console.log(`Database      : ${db[0].db}`);
    console.log(`Version       : ${db[0].ver.split(",")[0]}`);

    // List all tables with row counts
    const { rows: tables } = await client.query(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    console.log(`\nTables (${tables.length} total):`);
    let totalRows = 0;
    for (const { tablename } of tables) {
      const { rows: cnt } = await client.query(
        `SELECT COUNT(*) AS n FROM "${tablename}"`
      );
      const n = parseInt(cnt[0].n);
      totalRows += n;
      console.log(`  ${pad(tablename, 50)} ${rpad(n, 4)} rows`);
    }
    console.log(`  ${"─".repeat(56)}`);
    console.log(`  ${pad("TOTAL", 50)} ${rpad(totalRows, 4)} rows`);
  } finally {
    client.release();
  }
}

// ── 3. Quick Retrieval Smoke Test ─────────────────────────────────────────────

async function smokeTest() {
  console.log("\n" + "═".repeat(60));
  console.log("  RETRIEVAL SMOKE TEST");
  console.log("═".repeat(60));

  const queries = [
    {
      q: "What should the Agriculture Department do during a cyclone?",
      expectDoc: "Odisha_SDMP_2019",
      expectSection: "6.3.1",
    },
    {
      q: "How many houses were damaged during Cyclone Phailin?",
      expectDoc: "Phailin_RDNA_2013",
      expectSection: null,
    },
    {
      q: "What were the WASH needs after Fani?",
      expectDoc: "Cyclone Fani Joint Rapid Needs Assessment Report",
      expectSection: null,
    },
    {
      q: "How many cyclone shelters are in Puri district?",
      expectDoc: "puri_ddmp_2017_18",
      expectSection: null,
    },
    {
      q: "What is the ex-gratia for a disaster death in Odisha?",
      expectDoc: "Odisha_SDMP_2019",
      expectSection: null,
    },
  ];

  // Embed all queries
  const embedRes = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: queries.map(q => q.q),
  });

  for (let i = 0; i < queries.length; i++) {
    const { q, expectDoc, expectSection } = queries[i];
    const vector = embedRes.data[i].embedding;

    const results = await qdrant.search(COLLECTION, {
      vector,
      limit: 3,
      with_payload: ["document_id", "section_number", "section_title",
                     "section_type", "chunk_type", "document_role"],
      with_vector: false,
    });

    const top = results[0];
    const topDoc     = top?.payload?.document_id || "?";
    const topSection = top?.payload?.section_number || "?";
    const topScore   = top?.score?.toFixed(3) || "?";
    const topTitle   = top?.payload?.section_title || top?.payload?.section_id || "?";

    const docMatch  = topDoc.includes(expectDoc) || expectDoc.includes(topDoc);
    const secMatch  = !expectSection || topSection === expectSection;
    const pass      = docMatch && secMatch;

    console.log(`\n${pass ? "✅" : "❌"} "${q}"`);
    console.log(`   Top result : score=${topScore}  doc=${topDoc}`);
    console.log(`   Section    : ${topSection} — ${String(topTitle).slice(0, 50)}`);
    if (!docMatch) console.log(`   ⚠ Expected doc containing: ${expectDoc}`);
    if (!secMatch) console.log(`   ⚠ Expected section: ${expectSection}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔍 RAG Platform Inspection");
  console.log(`   ${new Date().toISOString()}`);

  try { await inspectQdrant(); }
  catch(e) { console.error("Qdrant error:", e.message); }

  try { await inspectPostgres(); }
  catch(e) { console.error("Postgres error:", e.message); }

  try { await smokeTest(); }
  catch(e) { console.error("Smoke test error:", e.message); }

  console.log("\n" + "═".repeat(60) + "\n");
  await pgPool.end();
}

main().catch(err => {
  console.error("Fatal:", err.message);
  process.exit(1);
});