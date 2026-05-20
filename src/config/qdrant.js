// src/config/qdrant.js
// Initialises the Qdrant REST client and verifies connectivity at startup.

import { QdrantClient } from "@qdrant/js-client-rest";
import "dotenv/config";

const COLLECTION = process.env.QDRANT_COLLECTION || "sdmp_chunks";

const client = new QdrantClient({
  host: process.env.QDRANT_HOST || "localhost",
  port: Number(process.env.QDRANT_PORT) || 6333,
});

/**
 * Verify the client can reach Qdrant.
 * Called once at startup — throws if Qdrant is unreachable.
 */
export async function connectQdrant() {
  const info = await client.getCollections();
  const names = info.collections.map((c) => c.name);
  console.log(
    `[qdrant]   ✓ Connected — ${names.length} collection(s): [${names.join(", ") || "none yet"}]`
  );

  // Warn (not crash) if the target collection is missing — ingestion hasn't run yet
  if (!names.includes(COLLECTION)) {
    console.warn(
      `[qdrant]   ⚠ Collection "${COLLECTION}" not found — run ingestion first.`
    );
  } else {
    const col = await client.getCollection(COLLECTION);
    console.log(
      `[qdrant]   ✓ Collection "${COLLECTION}" — ${col.points_count ?? "?"} points, ` +
        `vector size ${col.config?.params?.vectors?.size ?? "?"}`
    );
  }
}

export { COLLECTION };
export default client;