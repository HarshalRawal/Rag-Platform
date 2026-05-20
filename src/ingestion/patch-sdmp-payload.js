// src/ingestion/patch-sdmp-payload.js
//
// One-time patch — fixes the 154 SDMP chunks that were ingested via the
// original embedder.js before embed-chunks.js was built.
//
// Problem: those chunks have document_source="Odisha_SDMP_2019" but
//          document_id is missing/null, so inspect.js shows them as "unknown"
//          and cross-document filters don't work on them.
//
// Fix: scroll all points where document_id is null/missing, verify they
//      belong to the SDMP via document_source, then set_payload to add the
//      missing normalised fields.
//
// Usage:
//   node src/ingestion/patch-sdmp-payload.js            # dry run first
//   node src/ingestion/patch-sdmp-payload.js --apply    # actually patch

import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";

const COLLECTION = process.env.QDRANT_COLLECTION || "sdmp_chunks";

const qdrant = new QdrantClient({
  host: process.env.QDRANT_HOST || "localhost",
  port: Number(process.env.QDRANT_PORT) || 6333,
});

const APPLY = process.argv.includes("--apply");

// Fields to patch onto every SDMP chunk
const SDMP_PATCH = {
  document_id:          "Odisha_SDMP_2019",
  document_source:      "Odisha_SDMP_2019",   // already set, but ensure consistency
  document_role:        "framework",
  event_id:             null,
  access_policy:        "public",
  valid_as_of:          null,
  primary_hazard:       null,
  districts_mentioned:  [],
  states_covered:       ["Odisha, India"],
};

async function main() {
  console.log(`\n[patch] Mode: ${APPLY ? "APPLY (writing to Qdrant)" : "DRY RUN (no writes)"}`);
  console.log(`[patch] Collection: ${COLLECTION}\n`);

  // Collect all points where document_id is missing or null
  const topatch = [];
  let offset = null;

  do {
    const result = await qdrant.scroll(COLLECTION, {
      limit: 200,
      offset,
      with_payload: ["document_id", "document_source", "document_source"],
      with_vector: false,
    });

    for (const point of result.points) {
      const docId  = point.payload?.document_id;
      const docSrc = point.payload?.document_source;

      // Target: points with no document_id but with document_source = SDMP
      const missingDocId = !docId || docId === "unknown" || docId === null;
      const isSDMP = docSrc === "Odisha_SDMP_2019";

      if (missingDocId && isSDMP) {
        topatch.push(point.id);
      } else if (missingDocId && !isSDMP) {
        console.warn(`[patch] ⚠ Point ${point.id} has no document_id and unknown source: ${docSrc}`);
      }
    }

    offset = result.next_page_offset ?? null;
  } while (offset !== null);

  console.log(`[patch] Found ${topatch.length} points to patch`);

  if (topatch.length === 0) {
    console.log(`[patch] ✓ Nothing to patch — all points already have document_id`);
    return;
  }

  // Show sample
  console.log(`[patch] Sample IDs: ${topatch.slice(0, 3).join(", ")}...`);
  console.log(`[patch] Patch payload:`);
  console.log(JSON.stringify(SDMP_PATCH, null, 2));

  if (!APPLY) {
    console.log(`\n[patch] Dry run complete. Run with --apply to write changes.`);
    return;
  }

  // Apply patch in batches of 100
  const BATCH = 100;
  let patched = 0;

  for (let i = 0; i < topatch.length; i += BATCH) {
    const batch = topatch.slice(i, i + BATCH);

    await qdrant.setPayload(COLLECTION, {
      payload: SDMP_PATCH,
      points: batch,
    });

    patched += batch.length;
    console.log(`[patch] Patched ${patched}/${topatch.length} points`);
  }

  console.log(`\n[patch] ✓ Done — ${patched} SDMP points updated`);
  console.log(`[patch] Run node src/inspect.js to verify`);
}

main().catch(err => {
  console.error("[patch] Fatal:", err.message);
  process.exit(1);
});