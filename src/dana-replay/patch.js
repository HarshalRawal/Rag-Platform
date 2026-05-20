/**
 * PATCH for danaReplay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Replace the retrieveChunks() and buildPrompt() functions in danaReplay.js
 * with these versions.
 *
 * Root cause of "Bad Request":
 *   1. Chunks have NO "source" field — the filter on source="static"/"realtime"
 *      matched nothing and the "should"/"minimum_should" syntax caused a 400.
 *   2. valid_as_of is stored as "YYYY-MM" string, not a Unix timestamp — Qdrant
 *      range filter on a string field causes a 400.
 *
 * Fix strategy:
 *   - Static corpus chunks  → identified by disaster_name != "Dana"
 *                             (they are Phailin / Fani / SDMP)
 *   - Dana bulletin chunks  → identified by disaster_name == "Dana"
 *                             filtered by bulletin_no <= phase bulletin ceiling
 *   - valid_as_of filtering → done in JS after retrieval (string compare)
 *     because Qdrant range filter only works on numeric/float payload fields.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Map each phase to the max bulletin number visible at that as_of time ──────
// Phase 1: as_of 2024-10-21 18:00 → bulletins 1-2 available
// Phase 2: as_of 2024-10-23 06:00 → bulletins up to ~9
// Phase 3: as_of 2024-10-24 12:00 → bulletins up to ~17  ← primary eval
// Phase 4: as_of 2024-10-25 02:00 → bulletins up to ~22
// Phase 5: as_of 2024-10-26 08:00 → all bulletins
const PHASE_BULLETIN_CEILING = {
  "2024-10-21T18:00:00+05:30": 2,
  "2024-10-23T06:00:00+05:30": 9,
  "2024-10-24T12:00:00+05:30": 17,
  "2024-10-25T02:00:00+05:30": 22,
  "2024-10-26T08:00:00+05:30": 999, // all
};

// ─────────────────────────────────────────────────────────────────────────────
// QDRANT RETRIEVAL — fixed for actual payload schema
// ─────────────────────────────────────────────────────────────────────────────
async function retrieveChunks(queryVector, asOf, mode = "full") {
  const bulletinCeiling = PHASE_BULLETIN_CEILING[asOf] ?? 999;

  // ── Build separate filters for corpus and Dana bulletins ─────────────────

  // Corpus filter: everything that is NOT Dana (Phailin, Fani, SDMP 2019)
  const corpusFilter = {
    must_not: [
      { key: "disaster_name", match: { value: "Dana" } },
    ],
  };

  // Dana bulletins filter: only Dana chunks, only up to the bulletin ceiling
  // bulletin_no must be stored as an integer in payload for range to work.
  // If it's stored as a string we fall back to fetching all Dana chunks and
  // filtering in JS — handled below.
  const danaFilter = {
    must: [
      { key: "disaster_name", match: { value: "Dana" } },
    ],
  };

  let corpusChunks = [];
  let danaChunks = [];

  // ── Fetch based on mode ───────────────────────────────────────────────────
  if (mode === "full" || mode === "corpus_only") {
    const corpusResults = await qdrantClient.search(COLLECTION, {
      vector: queryVector,
      limit: mode === "corpus_only" ? TOP_K : Math.ceil(TOP_K / 2),
      filter: corpusFilter,
      with_payload: true,
      score_threshold: 0.3,
    });
    corpusChunks = corpusResults.map((r) => ({
      id: r.id,
      score: r.score,
      text: r.payload.chunk_text || r.payload.text || "",
      source: "corpus",
      doc_name:
        r.payload.document_title ||
        r.payload.document_source ||
        r.payload.document_id ||
        "unknown",
      disaster_name: r.payload.disaster_name || null,
      valid_as_of: r.payload.valid_as_of || null,
      warning_level: r.payload.warning_level || null,
      source_authority: r.payload.source_authority || "unknown",
      bulletin_no: null,
    }));
  }

  if (mode === "full" || mode === "rt_only") {
    const danaResults = await qdrantClient.search(COLLECTION, {
      vector: queryVector,
      limit: mode === "rt_only" ? TOP_K : Math.ceil(TOP_K / 2),
      filter: danaFilter,
      with_payload: true,
      score_threshold: 0.25, // slightly lower threshold for bulletins
    });

    // Filter by bulletin_no ceiling in JS (works whether stored as int or string)
    danaChunks = danaResults
      .map((r) => ({
        id: r.id,
        score: r.score,
        text: r.payload.chunk_text || r.payload.text || "",
        source: "realtime",
        doc_name:
          r.payload.document_title ||
          r.payload.document_source ||
          r.payload.bulletin_no
            ? `Dana Bulletin #${r.payload.bulletin_no}`
            : "Dana bulletin",
        disaster_name: r.payload.disaster_name || "Dana",
        valid_as_of: r.payload.valid_as_of || r.payload.issued_at || null,
        warning_level: r.payload.warning_level || null,
        source_authority: r.payload.source_authority || "IMD",
        bulletin_no: r.payload.bulletin_no
          ? parseInt(r.payload.bulletin_no)
          : null,
      }))
      .filter((c) => {
        // If bulletin_no is present, apply ceiling
        if (c.bulletin_no !== null) return c.bulletin_no <= bulletinCeiling;
        // If no bulletin_no, fall back to valid_as_of string compare
        if (c.valid_as_of) return c.valid_as_of <= asOf;
        return true; // include if no temporal metadata
      });
  }

  // ── Merge, deduplicate by id, re-rank by score ────────────────────────────
  const seen = new Set();
  const merged = [...corpusChunks, ...danaChunks]
    .filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K);

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDER — updated field names to match actual payload
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(phase, chunks, mode) {
  const contextBlocks = chunks
    .map((c, i) => {
      const sourceTag = c.source === "realtime" ? "📡 LIVE BULLETIN" : "📚 CORPUS";
      const bulletinTag = c.bulletin_no ? ` | Bulletin #${c.bulletin_no}` : "";
      const warningTag = c.warning_level ? ` | Warning: ${c.warning_level}` : "";
      const dateTag = c.valid_as_of ? ` | Date: ${c.valid_as_of}` : "";
      const authorityTag = ` | Authority: ${c.source_authority}`;
      return (
        `[${i + 1}] ${sourceTag} | ${c.doc_name}${bulletinTag}${warningTag}${dateTag}${authorityTag} | Score: ${(c.score * 100).toFixed(1)}%\n` +
        c.text
      );
    })
    .join("\n\n---\n\n");

  const modeNote =
    mode === "corpus_only"
      ? "CORPUS ONLY — You have access to the static knowledge base (SDMP 2019, Cyclone Phailin RDNA, Cyclone Fani JRNA). No real-time Dana bulletins are available."
      : mode === "rt_only"
      ? "BULLETINS ONLY — You only have access to real-time IMD Cyclone Dana bulletins. No historical documents or SDMP guidelines are available."
      : "FULL MODE — You have both real-time IMD Cyclone Dana bulletins AND the static knowledge base (SDMP 2019, Phailin RDNA, Fani JRNA).";

  return `You are an AI assistant supporting the Odisha State Disaster Management Authority (OSDMA).
Current situation timestamp: ${phase.as_of}
Active warning level: ${phase.warning_level}
Knowledge access: ${modeNote}

RETRIEVED CONTEXT (${chunks.length} chunks, ranked by relevance):
${"─".repeat(70)}
${contextBlocks}
${"─".repeat(70)}

OPERATOR QUERY:
${phase.query}

INSTRUCTIONS:
- Ground every recommendation in the retrieved context above.
- Cite the source document for key claims (e.g. "per SDMP §6.2" or "per Dana Bulletin #15").
- If the context is insufficient, explicitly state what is missing rather than guessing.
- Be direct and operational — this is for an emergency manager, not a researcher.
- Use clear numbered headings in your response.`;
}