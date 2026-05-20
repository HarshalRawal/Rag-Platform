/**
 * danaReplay.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cyclone Dana — Phase-by-Phase RAG Replay Evaluation
 *
 * Replays the 5 operational phases of Cyclone Dana (Oct 21–26, 2024) by
 * querying Qdrant with an `as_of` filter so the system only sees bulletins
 * that were actually available at that moment in time.
 *
 * Each phase runs the same pipeline:
 *   1. Embed the query (OpenAI text-embedding-3-small)
 *   2. Search Qdrant — filtered to chunks where valid_as_of <= phase timestamp
 *   3. Build a grounded prompt from retrieved chunks
 *   4. Call the LLM (Claude claude-sonnet-4-20250514)
 *   5. Log result + save to Postgres audit table + write JSON report
 *
 * Usage:
 *   node danaReplay.js                 → run all 5 phases
 *   node danaReplay.js --phase 3       → run only phase 3 (primary eval)
 *   node danaReplay.js --compare       → run phase 3 in 3 modes for paper comparison
 *
 * Dependencies:  @qdrant/js-client-rest  openai  @anthropic-ai/sdk  pg  dotenv
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import "dotenv/config";

// ── Import your project config files ────────────────────────────────────────
import qdrantClient, { connectQdrant, COLLECTION } from "../config/qdrant.js";
import { connectPostgres, query as pgQuery } from "../config/postgres.js";

// ── Clients ──────────────────────────────────────────────────────────────────
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EMBED_MODEL = "text-embedding-3-small";
const LLM_MODEL   = "claude-sonnet-4-6";
const TOP_K       = 8;   // chunks to retrieve per query
const REPORT_DIR  = "./reports";

// ── CLI flags ────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const PHASE_ONLY  = args.includes("--phase") ? parseInt(args[args.indexOf("--phase") + 1]) : null;
const COMPARE_MODE = args.includes("--compare");

// ─────────────────────────────────────────────────────────────────────────────
// PHASE DEFINITIONS
// Each phase maps to a real moment in Dana's lifecycle.
// `as_of` is the cutoff — Qdrant will only return chunks ingested before this.
// ─────────────────────────────────────────────────────────────────────────────
const PHASES = [
  {
    phase: 1,
    name: "Early watch",
    as_of: "2024-10-21T18:00:00+05:30",
    warning_level: "YELLOW",
    bulletins_available: "1–2",
    query: `A low pressure area has formed in the Bay of Bengal and is tracking toward the Odisha coast. 
IMD has issued a YELLOW watch. Wind speeds are below 60 km/h and the system is 900 km from the coast.
What early preparedness actions should the district administration take per the Odisha SDMP? 
Which departments need to be put on standby?`,
    expected_sdmp_section: "§5.2 – Early Warning Dissemination",
    evaluation_criteria: [
      "Cites SDMP early warning protocol",
      "Names correct departments to alert (ODRAF, NDRF, Revenue dept)",
      "Does NOT over-react — should not recommend evacuation yet",
    ],
  },
  {
    phase: 2,
    name: "Escalation to orange",
    as_of: "2024-10-23T06:00:00+05:30",
    warning_level: "ORANGE",
    bulletins_available: "8–9",
    query: `Cyclone Dana has intensified into a cyclonic storm. IMD has upgraded to ORANGE warning for 
the Odisha coast. Expected landfall in 48 hours near Kendrapara–Jagatsinghpur belt. 
Wind speeds forecast at 90–100 km/h at landfall. Storm surge of 1–2 m expected.
What evacuation and pre-positioning steps should the administration begin immediately? 
Which coastal districts need priority attention per the SDMP?`,
    expected_sdmp_section: "§6.1 – Preparedness Activation, §6.2 – Evacuation Protocol",
    evaluation_criteria: [
      "Triggers SDMP §6.1 preparedness activation",
      "Identifies correct high-risk districts (Kendrapara, Jagatsinghpur, Bhadrak)",
      "Mentions pre-positioning of NDRF teams and relief materials",
      "Recommends fishing vessel recall",
    ],
  },
  {
    phase: 3,
    name: "Pre-landfall — PRIMARY EVALUATION",
    as_of: "2024-10-24T12:00:00+05:30",
    warning_level: "RED",
    bulletins_available: "14–17",
    query: `RED WARNING is now active for the Odisha coast. Cyclone Dana is a Very Severe Cyclonic Storm 
with maximum sustained wind speed of 120 km/h, gusting to 135 km/h. 
Expected landfall near Bhitarkanika–Dhamra coast in approximately 15 hours (around 0100–0300 IST on Oct 25).
Storm surge of 2–3 m above astronomical tide is forecast for Kendrapara, Bhadrak, and Balasore districts.
Mandatory evacuation is required under SDMP §6.2.

Generate a complete operator briefing that includes:
1. Districts at highest risk ranked by priority
2. Mandatory evacuation trigger — is the SDMP threshold met?
3. Relief camp activation checklist
4. NDRF/ODRAF deployment recommendations  
5. How does this compare to the Cyclone Fani response in 2019?`,
    expected_sdmp_section: "§6.2 – Mandatory Evacuation, §7.1 – Relief Camp Activation",
    evaluation_criteria: [
      "Correctly triggers mandatory evacuation under SDMP §6.2",
      "Ranks Kendrapara, Bhadrak, Balasore as highest risk",
      "Cites Fani 2019 as historical precedent",
      "Provides actionable relief camp checklist",
      "Response reflects real-time bulletin data, not generic advice",
    ],
  },
  {
    phase: 4,
    name: "Active landfall",
    as_of: "2024-10-25T02:00:00+05:30",
    warning_level: "RED",
    bulletins_available: "20–22",
    query: `Cyclone Dana is making landfall right now at Dhamra, Bhadrak district. 
Bulletin 21 reports: eye of the storm crossing coast, wind speed 100–110 km/h, heavy to very heavy 
rainfall across 8 districts. Power and communications disrupted in Bhadrak and Kendrapara.
Storm surge inundation reported in low-lying coastal areas.

What are the immediate response priorities for the next 6 hours?
Which districts need emergency search and rescue pre-positioning?
What communication protocols should be activated when normal channels are disrupted?`,
    expected_sdmp_section: "§8.1 – Search and Rescue Operations, §8.3 – Emergency Communications",
    evaluation_criteria: [
      "Focuses on SAR operations, not pre-landfall planning",
      "Mentions backup communication protocols (HAM radio, satellite phones)",
      "Identifies Bhadrak and Kendrapara as immediate SAR priority",
      "Cites correct SDMP emergency response sections",
    ],
  },
  {
    phase: 5,
    name: "Post-landfall relief",
    as_of: "2024-10-26T08:00:00+05:30",
    warning_level: "WEAKENING",
    bulletins_available: "24–25",
    query: `Cyclone Dana has crossed the coast and is weakening rapidly as it moves inland over Jharkhand.
IMD bulletin 25 reports: system weakened to a deep depression. Rainfall continues in interior Odisha.
Affected districts: Bhadrak, Kendrapara, Balasore, Jajpur, Keonjhar — estimated 3.2 lakh people displaced.
Power restoration underway in coastal districts. Road connectivity partially restored.

What are the relief and recovery priorities for the next 48–72 hours?
What lessons from the Cyclone Fani 2019 response in Odisha should guide resource allocation?
What are the key early warning signs of secondary crises (disease outbreak, water contamination) to watch for?`,
    expected_sdmp_section: "§9.1 – Relief Operations, §10.1 – Early Recovery",
    evaluation_criteria: [
      "Shifts from emergency to relief mode",
      "Cites Fani 2019 recovery lessons (health camps, temporary shelter)",
      "Mentions disease outbreak prevention as secondary risk",
      "References SDMP relief camp management protocols",
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// EMBEDDING
// ─────────────────────────────────────────────────────────────────────────────
async function embedQuery(text) {
  const response = await openai.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

// ─────────────────────────────────────────────────────────────────────────────
// HYBRID RETRIEVAL — semantic search + SDMP pinned slots
//
// Dana bulletin chunks:  source = "imd_dana", valid_as_of = ISO string
// Corpus chunks:         no "source" field (SDMP, Phailin, Fani)
//
// Slot allocation (TOP_K = 8):
//   SDMP_SLOTS = 2  → reserved for SDMP response/preparedness chunks (pinned)
//   Remaining 6     → semantic search across Dana bulletins + rest of corpus
//
// SDMP slots are only filled when the query is "emergency-like" (contains
// trigger keywords). For non-emergency queries all 8 slots go to semantic.
//
// Why: SDMP policy text scores ~0.55–0.60 semantically against emergency
// queries — too low to beat Fani/Phailin event chunks (~0.67). But SDMP
// §6.x evacuation/response sections are exactly what operators need.
// Pinning ensures they're always present without harming recall quality.
// ─────────────────────────────────────────────────────────────────────────────

const SDMP_SLOTS      = 2;   // reserved slots for SDMP protocol chunks
const SDMP_DOC_ID     = "Odisha_SDMP_2019";
const SDMP_PHASES     = ["response", "preparedness"]; // covers_phases values to prefer

// Keywords that signal an emergency-protocol query → trigger SDMP pinning
const EMERGENCY_KEYWORDS = [
  "evacuation", "evacuate", "warning", "red warning", "orange warning",
  "mandatory", "landfall", "relief camp", "ndrf", "odraf", "sdmp",
  "search and rescue", "sar", "shelter", "deploy", "response priority",
  "immediate action", "activate",
];

function isEmergencyQuery(queryText) {
  const lower = queryText.toLowerCase();
  return EMERGENCY_KEYWORDS.some((kw) => lower.includes(kw));
}

// Dedicated SDMP search queries — phase-specific short phrases that semantically
// target the SDMP sections we actually need, instead of the long operator query.
// Using a short focused query gives much better SDMP section retrieval than the
// full operator query which pulls vulnerability/hazard sections instead.
const SDMP_SEARCH_QUERY_BY_PHASE = {
  1: "cyclone early warning preparedness district standby activation",
  2: "cyclone evacuation preparedness orange warning activation protocol",
  3: "mandatory evacuation cyclone red warning relief camp activation SDMP",
  4: "cyclone search rescue response emergency communication operations",
  5: "cyclone relief recovery operations post landfall displaced population",
};

function mapChunk(r, sourceOverride = null) {
  const p = r.payload;
  return {
    id:               r.id,
    score:            r.score,
    text:             p.chunk_text || p.text || "",
    source:           sourceOverride || p.source || "corpus",
    doc_name:         p.document_title || p.document_source || p.document_id || "corpus doc",
    valid_as_of:      p.valid_as_of || null,
    warning_level:    p.warning_level || null,
    source_authority: p.source_authority || "government",
    bulletin_no:      p.bulletin_no ?? null,
    phase:            p.phase || null,
    section_number:   p.section_number || null,
    section_title:    p.section_title || null,
    covers_phases:    p.covers_phases || [],
    pinned:           false,  // set true for SDMP pinned chunks
  };
}

async function retrieveChunks(queryVector, asOf, mode = "full", queryText = "", phaseNumber = 3) {
  let pinnedSdmpChunks = [];
  let corpusChunks     = [];
  let danaChunks       = [];

  const usePin    = (mode === "full" || mode === "corpus_only") && isEmergencyQuery(queryText);
  const sdmpSlots = usePin ? SDMP_SLOTS : 0;
  // Remaining semantic slots after reserving SDMP pins
  const semanticCorpusLimit = mode === "corpus_only"
    ? TOP_K - sdmpSlots
    : Math.ceil((TOP_K - sdmpSlots) * 0.55);

  // ── 1. SDMP pinned fetch (only for emergency queries) ─────────────────────
  // Uses a dedicated short SDMP search query (not the full operator query) so
  // we retrieve response/evacuation protocol sections, not vulnerability chapters.
  if (usePin) {
    const sdmpQueryText = SDMP_SEARCH_QUERY_BY_PHASE[phaseNumber]
      || "cyclone evacuation relief camp mandatory response protocol";
    const sdmpQueryVector = await embedQuery(sdmpQueryText);
    const sdmpResults = await qdrantClient.search(COLLECTION, {
      vector: sdmpQueryVector,
      limit: sdmpSlots * 4, // fetch extra so we can pick best-matching ones
      filter: {
        must: [
          { key: "document_id", match: { value: SDMP_DOC_ID } },
        ],
      },
      with_payload: true,
      score_threshold: 0.0, // no threshold — always want SDMP represented
    });

    pinnedSdmpChunks = sdmpResults
      .slice(0, sdmpSlots)
      .map((r) => ({ ...mapChunk(r, "corpus"), pinned: true }));

    if (pinnedSdmpChunks.length > 0) {
      console.log(`  📌 Pinned ${pinnedSdmpChunks.length} SDMP chunk(s):`);
      pinnedSdmpChunks.forEach((c) =>
        console.log(`      §${c.section_number} ${c.section_title} (score: ${(c.score * 100).toFixed(1)}%)`)
      );
    }
  }

  // ── 2. General corpus semantic search (Fani, Phailin, non-pinned SDMP) ────
  if (mode === "full" || mode === "corpus_only") {
    const pinnedIds = new Set(pinnedSdmpChunks.map((c) => c.id));
    const results = await qdrantClient.search(COLLECTION, {
      vector: queryVector,
      limit: semanticCorpusLimit + pinnedIds.size, // over-fetch to compensate for dedup
      filter: {
        must_not: [{ key: "source", match: { value: "imd_dana" } }],
      },
      with_payload: true,
      score_threshold: 0.3,
    });

    corpusChunks = results
      .map((r) => mapChunk(r, "corpus"))
      .filter((c) => !pinnedIds.has(c.id)) // exclude already-pinned SDMP chunks
      .slice(0, semanticCorpusLimit);
  }

  // ── 3. Dana bulletin fetch — temporal filter enforced in Qdrant ───────────
  // valid_as_of is stored as ISO 8601 string ("2024-10-24T05:30:00+05:30").
  // Qdrant range filter on string fields uses lexicographic comparison which
  // works correctly for ISO 8601 datetime strings of consistent format.
  // Verified: all imd_dana chunks have valid_as_of in this format.
  if (mode === "full" || mode === "rt_only") {
    const danaLimit = mode === "rt_only" ? TOP_K : Math.ceil((TOP_K - sdmpSlots) * 0.6);
    const results = await qdrantClient.search(COLLECTION, {
      vector: queryVector,
      limit: danaLimit,
      filter: {
        must: [
          { key: "source",      match: { value: "imd_dana" } },
          { key: "valid_as_of", range: { lte: asOf }         },
        ],
      },
      with_payload: true,
      score_threshold: 0.25,
    });

    danaChunks = results.map((r) => ({
      ...mapChunk(r, "imd_dana"),
      doc_name: `Dana Bulletin #${r.payload.bulletin_no}`,
    }));
  }

  // ── 4. Merge: pinned SDMP first, then semantic results re-ranked by score ──
  const seen   = new Set();
  // Pinned chunks go in first (guaranteed slots), then semantic by score
  const merged = [...pinnedSdmpChunks, ...corpusChunks, ...danaChunks]
    .filter((c) => { if (seen.has(c.id)) return false; seen.add(c.id); return true; })
    .sort((a, b) => {
      // Pinned chunks always sort to the top of the context window
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.score - a.score;
    })
    .slice(0, TOP_K);

  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(phase, chunks, mode) {
  const contextBlocks = chunks
    .map((c, i) => {
      const tag        = c.source === "imd_dana" ? "📡 LIVE BULLETIN" : "📚 CORPUS";
      const bulletinPart = c.bulletin_no != null ? ` | Bulletin #${c.bulletin_no}` : "";
      const phasePart    = c.phase         ? ` | Phase: ${c.phase}`          : "";
      const warningPart  = c.warning_level ? ` | Warning: ${c.warning_level}` : "";
      const datePart     = c.valid_as_of   ? ` | Issued: ${c.valid_as_of}`    : "";
      return (
        `[${i + 1}] ${tag} | ${c.doc_name}${bulletinPart}${phasePart}${warningPart}${datePart} | Authority: ${c.source_authority} | Score: ${(c.score * 100).toFixed(1)}%\n` +
        c.text
      );
    })
    .join("\n\n---\n\n");

  const modeNote =
    mode === "corpus_only"
      ? "CORPUS ONLY — Odisha SDMP 2019, Cyclone Phailin RDNA, Cyclone Fani JRNA. No real-time Dana bulletins."
      : mode === "rt_only"
      ? "BULLETINS ONLY — Real-time IMD Cyclone Dana bulletins only. No SDMP or historical reports."
      : "FULL MODE — Real-time IMD Dana bulletins AND static corpus (SDMP 2019, Phailin RDNA, Fani JRNA).";

  return `You are an AI assistant supporting the Odisha State Disaster Management Authority (OSDMA).
Current situation timestamp: ${phase.as_of}
Active warning level: ${phase.warning_level}
Knowledge access: ${modeNote}

RETRIEVED CONTEXT (${chunks.length} chunks — ranked by relevance):
${"─".repeat(68)}
${contextBlocks}
${"─".repeat(68)}

OPERATOR QUERY:
${phase.query}

INSTRUCTIONS:
- Ground every recommendation in the retrieved context above.
- Cite sources for key claims (e.g. "per SDMP §6.2" or "per Dana Bulletin #15").
- If context is insufficient for part of the query, say so explicitly — do not guess.
- Be direct and operational — this goes to an emergency manager, not a researcher.
- Use clear numbered headings in your response.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM CALL
// ─────────────────────────────────────────────────────────────────────────────
async function callLLM(prompt) {
  const start = Date.now();
  const message = await anthropic.messages.create({
    model: LLM_MODEL,
    max_tokens: 2500,
    messages: [{ role: "user", content: prompt }],
  });
  const latency_ms = Date.now() - start;
  const response_text = message.content[0].type === "text" ? message.content[0].text : "";
  return { response_text, latency_ms, input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens };
}

// ─────────────────────────────────────────────────────────────────────────────
// POSTGRES AUDIT LOG
// ─────────────────────────────────────────────────────────────────────────────
async function ensureAuditTable() {
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS dana_replay_audit (
      id              SERIAL PRIMARY KEY,
      run_id          TEXT NOT NULL,
      phase           INT NOT NULL,
      phase_name      TEXT NOT NULL,
      mode            TEXT NOT NULL DEFAULT 'full',
      as_of           TIMESTAMPTZ NOT NULL,
      warning_level   TEXT,
      query           TEXT NOT NULL,
      chunks_retrieved INT,
      chunk_sources   JSONB,
      prompt_tokens   INT,
      completion_tokens INT,
      latency_ms      INT,
      response        TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function saveAuditRecord(runId, phase, mode, chunks, llmResult) {
  const chunkSources = chunks.map((c) => ({
    doc: c.doc_name,
    source: c.source,
    score: parseFloat(c.score.toFixed(3)),
  }));

  await pgQuery(
    `INSERT INTO dana_replay_audit
      (run_id, phase, phase_name, mode, as_of, warning_level, query,
       chunks_retrieved, chunk_sources, prompt_tokens, completion_tokens, latency_ms, response)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      runId,
      phase.phase,
      phase.name,
      mode,
      phase.as_of,
      phase.warning_level,
      phase.query,
      chunks.length,
      JSON.stringify(chunkSources),
      llmResult.input_tokens,
      llmResult.output_tokens,
      llmResult.latency_ms,
      llmResult.response_text,
    ]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE PHASE RUNNER
// ─────────────────────────────────────────────────────────────────────────────
async function runPhase(phase, mode = "full", runId) {
  const modeLabel = mode === "full" ? "RAG + Bulletins" : mode === "corpus_only" ? "Corpus only" : "Bulletins only";
  console.log(`\n${"═".repeat(72)}`);
  console.log(`  Phase ${phase.phase}: ${phase.name}  [${modeLabel}]`);
  console.log(`  as_of: ${phase.as_of}  |  Warning: ${phase.warning_level}`);
  console.log(`  Bulletins available in DB: ${phase.bulletins_available}`);
  console.log(`${"═".repeat(72)}`);

  // 1. Embed query
  process.stdout.write("  Embedding query... ");
  const queryVector = await embedQuery(phase.query);
  console.log("✓");

  // 2. Retrieve with as_of filter
  process.stdout.write(`  Retrieving top-${TOP_K} chunks (mode=${mode})... `);
  const chunks = await retrieveChunks(queryVector, phase.as_of, mode, phase.query, phase.phase);
  console.log(`✓  ${chunks.length} chunks retrieved`);

  // Show what was retrieved
  chunks.forEach((c, i) => {
    const tag = c.source === "imd_dana" ? "📡" : c.pinned ? "📌" : "📚";
    const pin = c.pinned ? " [SDMP PINNED]" : "";
    console.log(`    ${tag} [${i + 1}] ${c.doc_name}${pin} (score: ${(c.score * 100).toFixed(1)}%)`);
  });

  // 3. Build prompt + call LLM
  const prompt = buildPrompt(phase, chunks, mode);
  process.stdout.write("  Calling LLM... ");
  const llmResult = await callLLM(prompt);
  console.log(`✓  (${llmResult.latency_ms}ms, ${llmResult.input_tokens}→${llmResult.output_tokens} tokens)`);

  // 4. Print response
  console.log("\n  ── LLM Response ──────────────────────────────────────────────");
  console.log(llmResult.response_text);
  console.log("  ──────────────────────────────────────────────────────────────");

  // 5. Print evaluation criteria checklist
  console.log("\n  ── Evaluation Checklist ──────────────────────────────────────");
  console.log(`  Expected SDMP section: ${phase.expected_sdmp_section}`);
  phase.evaluation_criteria.forEach((c) => console.log(`  ☐ ${c}`));

  // 6. Save to postgres
  await saveAuditRecord(runId, phase, mode, chunks, llmResult);
  console.log(`\n  ✓ Saved to dana_replay_audit (run_id=${runId})`);

  return {
    phase: phase.phase,
    name: phase.name,
    mode,
    as_of: phase.as_of,
    warning_level: phase.warning_level,
    chunks_retrieved: chunks.length,
    chunk_sources: chunks.map((c) => ({ doc: c.doc_name, source: c.source, score: c.score })),
    latency_ms: llmResult.latency_ms,
    input_tokens: llmResult.input_tokens,
    output_tokens: llmResult.output_tokens,
    response: llmResult.response_text,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE MODE — Phase 3 in 3 retrieval modes (for paper Table)
// Runs the same query 3 ways so you can show the difference in the paper.
// ─────────────────────────────────────────────────────────────────────────────
async function runCompareMode(runId) {
  console.log("\n🔬  COMPARE MODE — Phase 3 across 3 retrieval configurations");
  console.log("    This generates the key result table for the paper.\n");

  const phase3 = PHASES[2]; // zero-indexed
  const modes = ["corpus_only", "rt_only", "full"];
  const results = [];

  for (const mode of modes) {
    const result = await runPhase(phase3, mode, runId);
    results.push(result);
    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Print comparison summary
  console.log("\n\n📊  COMPARISON SUMMARY — Phase 3 (Pre-landfall, as_of 2024-10-24 12:00 IST)");
  console.log("─".repeat(72));
  console.log(
    `${"Mode".padEnd(20)} ${"Chunks".padEnd(10)} ${"Latency".padEnd(12)} ${"Tokens (in→out)"}`
  );
  console.log("─".repeat(72));
  for (const r of results) {
    const modeLabel =
      r.mode === "corpus_only" ? "Corpus only" : r.mode === "rt_only" ? "Bulletins only" : "Full (corpus + RT)";
    console.log(
      `${modeLabel.padEnd(20)} ${String(r.chunks_retrieved).padEnd(10)} ${(r.latency_ms + "ms").padEnd(12)} ${r.input_tokens}→${r.output_tokens}`
    );
  }
  console.log("─".repeat(72));
  console.log("\n  Key question: does the 'Full' mode produce a better briefing than either alone?");

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAVE JSON REPORT
// ─────────────────────────────────────────────────────────────────────────────
function saveReport(results, runId) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const filename = join(REPORT_DIR, `dana_replay_${runId}.json`);
  writeFileSync(filename, JSON.stringify({ run_id: runId, generated_at: new Date().toISOString(), results }, null, 2));
  console.log(`\n✓ Full report saved → ${filename}`);
  return filename;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   Cyclone Dana — RAG Platform Replay Evaluation                 ║");
  console.log("║   Disaster Management RAG · IIIT Bhubaneswar                    ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  // Generate a unique run ID for this evaluation session
  const runId = `dana_${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  console.log(`\nRun ID: ${runId}`);

  // Connect to infrastructure using your config files
  console.log("\nConnecting to infrastructure...");
  await connectQdrant();
  await connectPostgres();
  await ensureAuditTable();
  console.log("✓ Ready\n");

  let results = [];

  if (COMPARE_MODE) {
    // Run Phase 3 in all 3 modes — paper comparison table
    results = await runCompareMode(runId);
  } else if (PHASE_ONLY) {
    // Run a single specified phase
    const phase = PHASES.find((p) => p.phase === PHASE_ONLY);
    if (!phase) {
      console.error(`Phase ${PHASE_ONLY} not found. Valid phases: 1–5`);
      process.exit(1);
    }
    const result = await runPhase(phase, "full", runId);
    results = [result];
  } else {
    // Run all 5 phases in order
    console.log("Running all 5 phases in sequence...\n");
    for (const phase of PHASES) {
      const result = await runPhase(phase, "full", runId);
      results.push(result);
      // Brief pause between phases
      if (phase.phase < 5) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // Save full JSON report
  const reportPath = saveReport(results, runId);

  // Final summary
  console.log("\n\n📋  RUN SUMMARY");
  console.log("─".repeat(60));
  console.log(`Phases evaluated : ${results.length}`);
  console.log(`Total LLM calls  : ${results.length}`);
  console.log(
    `Total latency    : ${results.reduce((s, r) => s + r.latency_ms, 0)}ms`
  );
  console.log(
    `Total tokens     : ${results.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0)}`
  );
  console.log(`Audit table      : dana_replay_audit (postgres)`);
  console.log(`Report           : ${reportPath}`);
  console.log("─".repeat(60));
  console.log("\n✓ Dana replay complete.");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n✗ Fatal error:", err.message);
  console.error(err.stack);
  process.exit(1);
});