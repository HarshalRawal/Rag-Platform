// src/ingestion/embed-chunks.js
//
// Generic embedder — works for ANY document's chunk file.
// Supports both .jsonl (one JSON per line) and .json (array) formats.
// Auto-detects format from file extension.
//
// Usage:
//   node src/ingestion/embed-chunks.js --file <path>            # embed all chunks
//   node src/ingestion/embed-chunks.js --file <path> --dry-run  # preview, no API calls
//   node src/ingestion/embed-chunks.js --file <path> --resume   # skip already-ingested
//
// Supported chunk formats:
//
//   Format A (SDMP — our own chunker output .json):
//   { chunk_id, chunk_text, chunk_tokens, chapter, section_type, ... }
//
//   Format B (pre-built JSONL — e.g. Fani SitRep):
//   { chunk_id, text, metadata: { document_id, chunk_type, phase, ... } }
//
// Both formats are normalised into { id, text, payload } before embedding.
// All documents go into the SAME Qdrant collection (sdmp_chunks).
// Metadata filters (document_id, document_role, event_id) handle separation at query time.
//
// Requirements: npm install openai @qdrant/js-client-rest dotenv

import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";

// ── Config ────────────────────────────────────────────────────────────────────

const COLLECTION  = process.env.QDRANT_COLLECTION || "sdmp_chunks";
const EMBED_MODEL = "text-embedding-3-small";
const VECTOR_SIZE = 1536;
const BATCH_SIZE  = 100;
const COST_PER_M  = 0.02;  // $ per 1M tokens

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── ID normalisation ──────────────────────────────────────────────────────────
// Qdrant only accepts UUID strings or unsigned integers as point IDs.
// If the chunk_id is already a valid UUID, use it as-is.
// Otherwise generate a deterministic UUID v5 from the string so the same
// chunk always gets the same Qdrant ID (safe to re-run / resume).

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // DNS namespace

function toQdrantId(rawId) {
  if (UUID_RE.test(rawId)) return rawId;
  // Deterministic UUID v5 from the raw string ID
  const hash = crypto
    .createHash("sha1")
    .update(UUID_NAMESPACE + rawId)
    .digest("hex");
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    "5" + hash.slice(13, 16),   // version 5
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join("-");
}

const qdrant = new QdrantClient({
  host: process.env.QDRANT_HOST || "localhost",
  port: Number(process.env.QDRANT_PORT) || 6333,
});

// ── File reading ──────────────────────────────────────────────────────────────

function readChunkFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, "utf8");

  if (ext === ".jsonl") {
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l, i) => {
        try {
          return JSON.parse(l);
        } catch (e) {
          throw new Error(`Invalid JSON on line ${i + 1}: ${e.message}`);
        }
      });
  }

  if (ext === ".json") {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  throw new Error(
    `Unsupported file extension "${ext}". Expected .json or .jsonl`
  );
}

// ── Format normalisation ──────────────────────────────────────────────────────
// Converts either format into { id, text, payload }

function normalise(chunk) {
  // ── Format B: { chunk_id, text, metadata: {...} } ─────────────────────────
  // e.g. Fani SitRep, Fani JRNA, and any future pre-processed docs
  if (chunk.text !== undefined && chunk.metadata !== undefined) {
    const m = chunk.metadata;
    return {
      id:   chunk.chunk_id || m.chunk_id,
      text: chunk.text,
      payload: {
        // Store full text so Qdrant returns it at query time
        chunk_text:    chunk.text,

        // Flatten all metadata fields to top level
        ...m,

        // Normalised fields for cross-document filter compatibility
        document_id:      m.document_id       ?? null,
        document_source:  m.document_id       ?? null,   // alias for SDMP compat
        document_role:    m.document_role      ?? null,
        event_id:         m.event_id           ?? null,
        chunk_type:       m.chunk_type         ?? null,
        section_type:     m.chunk_type         ?? null,   // alias for SDMP compat
        access_policy:    m.access_policy      ?? "public",
        valid_as_of:      m.valid_as_of        ?? null,
        phase:            m.phase              ?? null,
        primary_hazard:   m.primary_hazard     ?? null,
        hazard_tags:      m.hazard_tags        ?? [],
        districts_mentioned: m.districts_mentioned ?? [],
        states_covered:   m.states_covered     ?? [],
      },
    };
  }

  // ── Format A: { chunk_id, chunk_text, chunk_tokens, chapter, ... } ────────
  // Our own SDMP chunker output
  if (chunk.chunk_text !== undefined) {
    return {
      id:   chunk.chunk_id,
      text: chunk.chunk_text,
      payload: {
        ...chunk,

        // Normalised fields for cross-document filter compatibility
        document_id:      chunk.document_source  ?? null,
        document_source:  chunk.document_source  ?? null,
        document_role:    chunk.document_role    ?? "framework",
        event_id:         chunk.event_id         ?? null,
        chunk_type:       chunk.section_type     ?? null,
        section_type:     chunk.section_type     ?? null,
        access_policy:    chunk.access_policy    ?? "public",
        valid_as_of:      null,
        phase:            null,
        primary_hazard:   null,
        hazard_tags:      chunk.covers_disaster_types ?? [],
        districts_mentioned: [],
        states_covered:   [],
      },
    };
  }

  // ── Format C: flat JSON — all metadata at top level alongside text ────────
  // e.g. Fani JRNA: { chunk_id, text, sector, content_type, agencies_mentioned, ... }
  // No nested metadata object — everything is a sibling of text.
  if (chunk.text !== undefined && chunk.chunk_id !== undefined) {
    return {
      id:   chunk.chunk_id,
      text: chunk.text,
      payload: {
        // Store full text
        chunk_text:   chunk.text,

        // Spread all flat fields
        ...chunk,

        // Normalised fields for cross-document filter compatibility
        document_id:      chunk.source_document   ?? chunk.chunk_id,
        document_source:  chunk.source_document   ?? null,
        document_role:    chunk.document_role     ?? "evaluation_ground_truth",
        event_id:         chunk.disaster_name
                            ? `cyclone_${chunk.disaster_name.toLowerCase()}_${chunk.event_date?.slice(0,4) ?? "2019"}`
                            : null,
        chunk_type:       chunk.chunk_type        ?? null,
        section_type:     chunk.chunk_type        ?? null,
        access_policy:    chunk.access_policy     ?? "public",
        valid_as_of:      chunk.publication_date  ?? null,
        phase:            Array.isArray(chunk.time_phase)
                            ? chunk.time_phase.join(",")
                            : (chunk.time_phase ?? null),
        primary_hazard:   chunk.disaster_type     ?? null,
        hazard_tags:      chunk.disaster_type ? [chunk.disaster_type] : [],
        districts_mentioned: chunk.worst_affected_districts
                            ?? chunk.affected_districts
                            ?? [],
        states_covered:   chunk.region ? [chunk.region] : [],
      },
    };
  }

  throw new Error(
    `Unrecognised chunk format.\n` +
    `Expected { text, metadata }, { chunk_text, ... }, or flat { chunk_id, text, ...fields }.\n` +
    `Keys found: ${Object.keys(chunk).join(", ")}`
  );
}

// ── Qdrant collection setup ───────────────────────────────────────────────────

async function ensureCollection() {
  const info   = await qdrant.getCollections();
  const exists = info.collections.some((c) => c.name === COLLECTION);

  if (!exists) {
    console.log(`[embed-chunks] Creating collection "${COLLECTION}"…`);
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });

    // Payload indexes — superset covering SDMP + Fani + future docs
    const indexes = [
      "document_id",    "document_source",  "document_role",
      "event_id",       "section_type",     "chunk_type",
      "chapter",        "department",       "phase",
      "access_policy",  "primary_hazard",   "temporal_validity",
      "geographic_scope", "valid_as_of",    "sql_table_name",
    ];
    for (const field of indexes) {
      await qdrant.createPayloadIndex(COLLECTION, {
        field_name:   field,
        field_schema: "keyword",
      });
    }
    console.log(`[embed-chunks] ✓ Collection created with payload indexes`);
  } else {
    const col = await qdrant.getCollection(COLLECTION);
    console.log(
      `[embed-chunks] ✓ Collection "${COLLECTION}" exists — ` +
      `${col.points_count ?? 0} points currently stored`
    );
  }
}

// ── Resume: get already-ingested IDs ─────────────────────────────────────────

async function getExistingIds() {
  const existing = new Set();
  let offset = null;

  do {
    const result = await qdrant.scroll(COLLECTION, {
      limit: 1000,
      offset,
      with_payload: false,
      with_vector:  false,
    });
    for (const point of result.points) existing.add(point.id);
    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  return existing;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function batchArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function estimateTokens(text) {
  // Rough estimate: 1 token ≈ 4 chars (good enough for cost preview)
  return Math.ceil(text.length / 4);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes("--dry-run");
  const resume  = args.includes("--resume");
  const fileIdx = args.indexOf("--file");

  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error(
      "Usage: node src/ingestion/embed-chunks.js --file <path> [--dry-run] [--resume]"
    );
    process.exit(1);
  }

  const filePath = args[fileIdx + 1];

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  // ── 1. Read + normalise ───────────────────────────────────────────────────
  console.log(`\n[embed-chunks] Reading: ${filePath}`);
  const raw    = readChunkFile(filePath);
  const chunks = raw.map((c, i) => {
    try {
      return normalise(c);
    } catch (e) {
      throw new Error(`Chunk ${i + 1}: ${e.message}`);
    }
  });

  console.log(`[embed-chunks] ${chunks.length} chunks loaded`);

  // Show document breakdown
  const docCounts = {};
  for (const c of chunks) {
    const doc = c.payload.document_id || c.payload.document_source || "unknown";
    docCounts[doc] = (docCounts[doc] || 0) + 1;
  }
  console.log(`[embed-chunks] Documents in file:`);
  for (const [doc, count] of Object.entries(docCounts)) {
    console.log(`               ${doc} → ${count} chunks`);
  }

  // Token + cost estimate
  const totalTokens  = chunks.reduce((s, c) => s + estimateTokens(c.text), 0);
  const estimatedCost = ((totalTokens / 1_000_000) * COST_PER_M).toFixed(5);
  console.log(`[embed-chunks] Est. tokens : ~${totalTokens.toLocaleString()}`);
  console.log(`[embed-chunks] Est. cost   : ~$${estimatedCost} (${EMBED_MODEL})`);

  if (dryRun) {
    console.log(`\n[embed-chunks] Dry run — no API calls, no Qdrant writes.`);

    // Show sample of first 3 normalised chunks
    console.log(`\n[embed-chunks] Sample (first 3 normalised chunks):`);
    chunks.slice(0, 3).forEach((c, i) => {
      console.log(`\n  [${i + 1}] id=${c.id}`);
      console.log(`       document_id=${c.payload.document_id}`);
      console.log(`       document_role=${c.payload.document_role}`);
      console.log(`       chunk_type=${c.payload.chunk_type}`);
      console.log(`       phase=${c.payload.phase}`);
      console.log(`       text preview: "${c.text.slice(0, 100).replace(/\n/g, " ")}…"`);
    });
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set in .env");
  }

  // ── 2. Ensure Qdrant collection ───────────────────────────────────────────
  await ensureCollection();

  // ── 3. Resume: filter already-ingested ───────────────────────────────────
  let toEmbed = chunks;
  if (resume) {
    console.log(`\n[embed-chunks] --resume: checking existing Qdrant points…`);
    const existingIds = await getExistingIds();
    toEmbed = chunks.filter((c) => !existingIds.has(toQdrantId(c.id)));
    console.log(
      `[embed-chunks] ${existingIds.size} already ingested, ` +
      `${toEmbed.length} remaining`
    );
    if (toEmbed.length === 0) {
      console.log(`[embed-chunks] ✓ All chunks already ingested.`);
      return;
    }
  }

  // ── 4. Embed + upsert in batches ──────────────────────────────────────────
  const batches = batchArray(toEmbed, BATCH_SIZE);
  let totalIngested  = 0;
  let totalTokensUsed = 0;
  const t0 = Date.now();

  console.log(
    `\n[embed-chunks] Embedding ${toEmbed.length} chunks ` +
    `in ${batches.length} batch(es) of ${BATCH_SIZE}…\n`
  );

  for (let i = 0; i < batches.length; i++) {
    const batch    = batches[i];
    const batchNum = i + 1;
    const texts    = batch.map((c) => c.text);

    // Call OpenAI embeddings
    let embResponse;
    try {
      embResponse = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: texts,
      });
    } catch (err) {
      if (err?.status === 429) {
        console.warn(`[embed-chunks] Rate limited on batch ${batchNum} — waiting 60s…`);
        await sleep(60_000);
        embResponse = await openai.embeddings.create({
          model: EMBED_MODEL,
          input: texts,
        });
      } else {
        throw new Error(`OpenAI error on batch ${batchNum}: ${err.message}`);
      }
    }

    const vectors     = embResponse.data.map((d) => d.embedding);
    const tokensUsed  = embResponse.usage?.total_tokens ?? 0;
    totalTokensUsed  += tokensUsed;

    // Build Qdrant points — convert raw IDs to valid Qdrant UUIDs
    const points = batch.map((chunk, idx) => ({
      id:      toQdrantId(chunk.id),
      vector:  vectors[idx],
      payload: { ...chunk.payload, original_chunk_id: chunk.id },
    }));

    // Upsert into Qdrant
    await qdrant.upsert(COLLECTION, { wait: true, points });

    totalIngested += batch.length;
    const elapsed   = ((Date.now() - t0) / 1000).toFixed(1);
    const actualCost = ((totalTokensUsed / 1_000_000) * COST_PER_M).toFixed(5);

    console.log(
      `[embed-chunks] Batch ${String(batchNum).padStart(2)}/${batches.length}  ` +
      `${String(totalIngested).padStart(3)}/${toEmbed.length} chunks  ` +
      `tokens=${totalTokensUsed.toLocaleString()}  ` +
      `cost=$${actualCost}  ` +
      `elapsed=${elapsed}s`
    );

    if (i < batches.length - 1) await sleep(200);
  }

  // ── 5. Final summary ──────────────────────────────────────────────────────
  const col        = await qdrant.getCollection(COLLECTION);
  const finalCost  = ((totalTokensUsed / 1_000_000) * COST_PER_M).toFixed(5);

  console.log(`
[embed-chunks] ─────────────────────────────────────────────
[embed-chunks] ✓ Done
[embed-chunks] Chunks ingested  : ${totalIngested}
[embed-chunks] Tokens used      : ${totalTokensUsed.toLocaleString()}
[embed-chunks] Actual cost      : $${finalCost}
[embed-chunks] Total in Qdrant  : ${col.points_count ?? "?"}
[embed-chunks] Collection       : ${COLLECTION}
[embed-chunks] ─────────────────────────────────────────────`);
}

main().catch((err) => {
  console.error("[embed-chunks] Fatal:", err.message);
  process.exit(1);
});