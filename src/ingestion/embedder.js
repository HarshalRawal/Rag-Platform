// src/ingestion/embedder.js
//
// Stage 3 — Embed chunks.json and upsert vectors + full metadata into Qdrant.
//
// Usage:
//   node src/ingestion/embedder.js                   # embeds all chunks
//   node src/ingestion/embedder.js --dry-run         # connects, counts chunks, no API calls
//   node src/ingestion/embedder.js --resume          # skips chunk_ids already in Qdrant
//
// What it does:
//   1. Reads chunks.json (output of chunker.js)
//   2. Creates Qdrant collection "sdmp_chunks" if it doesn't exist
//      (vector size 1536, Cosine distance — matches text-embedding-3-small)
//   3. Calls OpenAI embeddings API in batches of 100 chunks
//   4. Upserts each point into Qdrant:
//        id      → deterministic UUID from chunk_id
//        vector  → 1536-dim float array from OpenAI
//        payload → full chunk object (chunk_text + all metadata fields)
//   5. Logs progress, token usage, and estimated cost
//
// Requirements:
//   npm install openai @qdrant/js-client-rest dotenv
//
// .env keys needed:
//   OPENAI_API_KEY=sk-...
//   QDRANT_HOST=localhost        (or your container host)
//   QDRANT_PORT=6333
//   QDRANT_COLLECTION=sdmp_chunks

import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Config ────────────────────────────────────────────────────────────────────

const CHUNKS_FILE  = process.env.CHUNKS_FILE       || "./src/ingestion/chunks.json";
const COLLECTION   = process.env.QDRANT_COLLECTION || "sdmp_chunks";
const EMBED_MODEL  = "text-embedding-3-small";
const VECTOR_SIZE  = 1536;   // text-embedding-3-small output dimension
const BATCH_SIZE   = 100;    // chunks per OpenAI API call (max 2048, but 100 is safe)
const UPSERT_BATCH = 100;    // points per Qdrant upsert call

// Cost reference (as of 2024): $0.02 per 1M tokens for text-embedding-3-small
const COST_PER_MILLION = 0.02;

// ── Clients ───────────────────────────────────────────────────────────────────

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const qdrant = new QdrantClient({
  host: process.env.QDRANT_HOST || "localhost",
  port: Number(process.env.QDRANT_PORT) || 6333,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function batchArray(arr, size) {
  const batches = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

// Convert chunk_id (UUID string) to a Qdrant-compatible numeric ID.
// Qdrant supports both string UUIDs and unsigned integers.
// We use the UUID string directly — Qdrant REST API accepts it fine.
function toQdrantId(chunk_id) {
  return chunk_id;  // UUID string — Qdrant accepts this natively
}

// Build the Qdrant payload from a chunk.
// Stores EVERYTHING: chunk_text, all metadata fields.
// This means at query time you get the full chunk back — no separate lookup needed.
function buildPayload(chunk) {
  return {
    // ── Content ───────────────────────────────────────────────────────────────
    chunk_text:             chunk.chunk_text,
    chunk_tokens:           chunk.chunk_tokens,

    // ── Document-level metadata ───────────────────────────────────────────────
    document_source:        chunk.document_source,
    document_filename:      chunk.document_filename,
    document_year:          chunk.document_year,
    document_month:         chunk.document_month,
    publisher:              chunk.publisher,
    issuing_authority:      chunk.issuing_authority,
    legal_basis:            chunk.legal_basis,
    document_role:          chunk.document_role,
    geographic_scope:       chunk.geographic_scope,
    geographic_specificity: chunk.geographic_specificity,
    temporal_validity:      chunk.temporal_validity,
    language:               chunk.language,

    // ── Chunk-level metadata ──────────────────────────────────────────────────
    chapter:                chunk.chapter,
    section_number:         chunk.section_number  ?? null,
    section_title:          chunk.section_title   ?? null,
    section_type:           chunk.section_type,
    department:             chunk.department      ?? null,
    covers_disaster_types:  chunk.covers_disaster_types  ?? [],
    covers_phases:          chunk.covers_phases          ?? [],
    source_line_range_start: chunk.source_line_range_start ?? null,
    source_line_range_end:   chunk.source_line_range_end   ?? null,

    // ── SQL routing field (table_summary chunks only) ─────────────────────────
    sql_table_name:         chunk.sql_table_name  ?? null,
  };
}

// ── Qdrant collection setup ───────────────────────────────────────────────────

async function ensureCollection(recreate = false) {
  const info = await qdrant.getCollections();
  const exists = info.collections.some((c) => c.name === COLLECTION);

  if (exists && recreate) {
    console.log(`[qdrant] Deleting existing collection "${COLLECTION}"…`);
    await qdrant.deleteCollection(COLLECTION);
  }

  if (!exists || recreate) {
    console.log(`[qdrant] Creating collection "${COLLECTION}" (size=${VECTOR_SIZE}, distance=Cosine)…`);
    await qdrant.createCollection(COLLECTION, {
      vectors: {
        size:     VECTOR_SIZE,
        distance: "Cosine",
      },
    });

    // Create payload indexes for fields we'll filter on at query time
    const indexFields = [
      { field: "section_type",   schema: "keyword" },
      { field: "chapter",        schema: "keyword" },
      { field: "department",     schema: "keyword" },
      { field: "document_source",schema: "keyword" },
      { field: "document_role",  schema: "keyword" },
      { field: "temporal_validity", schema: "keyword" },
      { field: "covers_disaster_types", schema: "keyword" },
      { field: "covers_phases",  schema: "keyword" },
      { field: "sql_table_name", schema: "keyword" },
    ];

    for (const { field, schema } of indexFields) {
      await qdrant.createPayloadIndex(COLLECTION, {
        field_name:   field,
        field_schema: schema,
      });
    }
    console.log(`[qdrant] ✓ Collection created with ${indexFields.length} payload indexes`);
  } else {
    const col = await qdrant.getCollection(COLLECTION);
    console.log(
      `[qdrant] ✓ Collection "${COLLECTION}" already exists — ` +
      `${col.points_count ?? 0} points currently stored`
    );
  }
}

// ── Get already-ingested IDs (for --resume) ───────────────────────────────────

async function getExistingIds() {
  const existing = new Set();
  let offset = null;

  // Scroll through all points to collect IDs
  // (only fetches IDs, not vectors — fast)
  do {
    const result = await qdrant.scroll(COLLECTION, {
      limit: 1000,
      offset,
      with_payload: false,
      with_vector:  false,
    });
    for (const point of result.points) {
      existing.add(point.id);
    }
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  return existing;
}

// ── OpenAI embedding call ────────────────────────────────────────────────────

async function embedBatch(texts) {
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });

  // response.data is ordered the same as the input texts
  const vectors = response.data.map((d) => d.embedding);
  const tokensUsed = response.usage?.total_tokens ?? 0;

  return { vectors, tokensUsed };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes("--dry-run");
  const resume  = args.includes("--resume");
  const recreate = args.includes("--recreate");  // drop + recreate collection

  // ── 1. Read chunks ──────────────────────────────────────────────────────────
  if (!fs.existsSync(CHUNKS_FILE)) {
    throw new Error(
      `chunks.json not found at: ${CHUNKS_FILE}\n` +
      `Run the chunker first: node src/ingestion/chunker.js`
    );
  }

  const chunks = JSON.parse(fs.readFileSync(CHUNKS_FILE, "utf8"));
  console.log(`\n[embedder] Loaded ${chunks.length} chunks from ${CHUNKS_FILE}`);

  // Token + cost estimate
  const totalTokens = chunks.reduce((s, c) => s + (c.chunk_tokens ?? 0), 0);
  const estimatedCost = ((totalTokens / 1_000_000) * COST_PER_MILLION).toFixed(4);
  console.log(`[embedder] Total tokens : ${totalTokens.toLocaleString()}`);
  console.log(`[embedder] Est. cost    : ~$${estimatedCost} (${EMBED_MODEL})`);

  if (dryRun) {
    console.log(`\n[embedder] Dry run — no API calls, no Qdrant writes.`);
    console.log(`[embedder] When ready, run without --dry-run to embed and ingest.`);
    return;
  }

  // ── 2. Verify OpenAI key ────────────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in your .env file");
  }

  // ── 3. Qdrant setup ─────────────────────────────────────────────────────────
  await ensureCollection(recreate);

  // ── 4. Resume: filter out already-ingested chunks ───────────────────────────
  let toEmbed = chunks;
  if (resume) {
    console.log(`[embedder] --resume: checking existing Qdrant points…`);
    const existingIds = await getExistingIds();
    toEmbed = chunks.filter((c) => !existingIds.has(c.chunk_id));
    console.log(
      `[embedder] ${existingIds.size} already ingested, ` +
      `${toEmbed.length} remaining`
    );
    if (toEmbed.length === 0) {
      console.log(`[embedder] ✓ All chunks already ingested. Nothing to do.`);
      return;
    }
  }

  // ── 5. Embed + upsert in batches ────────────────────────────────────────────
  const batches = batchArray(toEmbed, BATCH_SIZE);
  let totalIngested = 0;
  let totalTokensUsed = 0;
  const t0 = Date.now();

  console.log(
    `\n[embedder] Embedding ${toEmbed.length} chunks in ${batches.length} batches of ${BATCH_SIZE}…\n`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNum = i + 1;

    // Extract texts for embedding
    const texts = batch.map((c) => c.chunk_text);

    // Call OpenAI
    let vectors, tokensUsed;
    try {
      ({ vectors, tokensUsed } = await embedBatch(texts));
      totalTokensUsed += tokensUsed;
    } catch (err) {
      // Rate limit: wait 60s and retry once
      if (err?.status === 429) {
        console.warn(`[embedder] Rate limited on batch ${batchNum} — waiting 60s…`);
        await sleep(60_000);
        ({ vectors, tokensUsed } = await embedBatch(texts));
        totalTokensUsed += tokensUsed;
      } else {
        throw new Error(`OpenAI error on batch ${batchNum}: ${err.message}`);
      }
    }

    // Build Qdrant points
    const points = batch.map((chunk, idx) => ({
      id:      toQdrantId(chunk.chunk_id),
      vector:  vectors[idx],
      payload: buildPayload(chunk),
    }));

    // Upsert into Qdrant (split into upsert batches if needed)
    const upsertBatches = batchArray(points, UPSERT_BATCH);
    for (const uBatch of upsertBatches) {
      await qdrant.upsert(COLLECTION, {
        wait:   true,   // wait for Qdrant to confirm write before continuing
        points: uBatch,
      });
    }

    totalIngested += batch.length;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const actualCost = ((totalTokensUsed / 1_000_000) * COST_PER_MILLION).toFixed(5);

    console.log(
      `[embedder] Batch ${String(batchNum).padStart(2)}/${batches.length}  ` +
      `${String(totalIngested).padStart(3)}/${toEmbed.length} chunks  ` +
      `tokens=${totalTokensUsed.toLocaleString()}  ` +
      `cost=$${actualCost}  ` +
      `elapsed=${elapsed}s`
    );

    // Polite pause between batches to avoid rate limits (except last batch)
    if (i < batches.length - 1) {
      await sleep(200);
    }
  }

  // ── 6. Final summary ────────────────────────────────────────────────────────
  const totalMs = Date.now() - t0;
  const finalCost = ((totalTokensUsed / 1_000_000) * COST_PER_MILLION).toFixed(5);

  // Verify count in Qdrant
  const col = await qdrant.getCollection(COLLECTION);
  const pointsInQdrant = col.points_count ?? "?";

  console.log(`
[embedder] ─────────────────────────────────────────────
[embedder] ✓ Done
[embedder] Chunks ingested  : ${totalIngested}
[embedder] Tokens used      : ${totalTokensUsed.toLocaleString()}
[embedder] Actual cost      : $${finalCost}
[embedder] Time taken       : ${(totalMs / 1000).toFixed(1)}s
[embedder] Qdrant points    : ${pointsInQdrant}
[embedder] Collection       : ${COLLECTION}
[embedder] ─────────────────────────────────────────────`);
}

main().catch((err) => {
  console.error("[embedder] Fatal:", err.message);
  process.exit(1);
});