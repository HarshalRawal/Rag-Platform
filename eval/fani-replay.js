// eval/fani-replay.js
//
// Fani Replay — Evaluation Harness (final, corrected)
//
// MODEL SPLIT:
//   Embeddings  → OpenAI text-embedding-3-small   (OPENAI_API_KEY)
//   Generation  → Claude claude-sonnet-4-6         (ANTHROPIC_API_KEY)
//   Judge/Score → Claude claude-sonnet-4-6         (same key, separate call)
//
// FIXES APPLIED (vs previous run):
//   1. HA ground truth corrected — Brahmagiri has 1 boat (LOWEST, not highest).
//      Puri Sadar and Kanas have 4 boats each (joint highest). Verified from SQL.
//   2. PB ground truth expanded — now reflects the full SDMP §6.3.3 protocol
//      content including CDMO Incident Commander role, time-phased windows,
//      blood bank activation, private hospital requisition, and triage protocol.
//   3. Judge prompt hardened — explicitly instructs the judge that if a Config A
//      answer cites UNICEF SitRep #2 (12 May 2019) or Fani JRNA as sources
//      with HIGH confidence, that is a temporal filter failure and scores 0 on
//      appropriate_uncertainty, regardless of factual accuracy of the figures.
//
// WHAT THIS TESTS:
//   Simulates the morning of 2 May 2019 — day before Cyclone Fani landfall.
//   8 queries across 4 categories, each testing a distinct engineering property:
//
//   PLANNING (2)      — SQL retrieval + Qdrant SOP retrieval
//   IMPACT (2)        — Config A must refuse; Config B returns verified figures
//   CONTAMINATION (2) — CRAG must detect Phailin event_id mismatch and block
//   HYBRID (2)        — Partially answerable pre-event, partial refusal required
//
// TWO CONFIGURATIONS:
//   Config A — as_of: 2019-05-02  temporal filter active, CRAG active
//   Config B — no as_of filter    full corpus, CRAG active
//
// SCORING (per query, max 9):
//   Factual Grounding       0-3
//   SOP Alignment           0-3
//   Appropriate Uncertainty 0-3
//
// OUTPUT → eval/results/fani-replay/<timestamp>/
//   summary.json, results.json, results.csv, evaluation-criteria.json, raw/

import "dotenv/config";
import Anthropic  from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "fs";
import { join }       from "path";
import { randomUUID } from "crypto";
import { connectPostgres } from "../src/config/postgres.js";
import { connectQdrant }   from "../src/config/qdrant.js";
import { runWithCRAG }     from "../src/agents/crag-critic.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const CONFIG_A_ONLY = args.includes("--config-a-only");
const CONFIG_B_ONLY = args.includes("--config-b-only");
const DRY_RUN       = args.includes("--dry-run");
const SINGLE_ID     = args.includes("--query")
  ? args[args.indexOf("--query") + 1]
  : null;

// ── Anthropic client ──────────────────────────────────────────────────────────

const anthropic   = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JUDGE_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-6";

// ── 8 benchmark queries ───────────────────────────────────────────────────────

const BENCHMARK = [

  // ── PLANNING (2) ─────────────────────────────────────────────────────────

  {
    id: "PA",
    category: "PLANNING",
    role: "operator",
    query:
      "What is the SDRF norm for assistance to a fully damaged pucca house after a cyclone in Odisha?",
    ground_truth:
      "Rs. 95,100 per house in plain areas; Rs. 1,01,900 in hilly/IAP districts. The house must be an authorised construction certified by the Competent Authority. SDRF is funded 75% Centre + 25% State. [SDMP Table 9.3 — sdmp_table_9_3_sdrf_norms_of_assistance, PostgreSQL]",
    key_facts: ["95,100", "pucca", "fully damaged", "SDRF", "plain areas"],
    answerable_without_fani: true,
    engineering_property:
      "Exact SQL retrieval from SDRF norms table. Single verifiable rupee figure — pass/fail is unambiguous.",
  },

  {
    // FIX 2: Ground truth expanded to match what SDMP §6.3.3 Table 6.2 actually contains.
    // The previous ground truth was a 6-bullet summary that missed the time-phased
    // structure the system correctly retrieved. Judge was penalising correct answers.
    id: "PB",
    category: "PLANNING",
    role: "operator",
    query:
      "What must the Health Department do in the first 24 hours after a cyclone RED alert is issued in coastal Odisha per the SDMP?",
    ground_truth:
      "SDMP §6.3.3 Table 6.2 specifies a four-window time-phased response: " +
      "(0–2 hrs) CDMO assumes role of Incident Commander; ambulance dispatched immediately; CHC/SDH/DHH put on standby; control room opened at ADMO office with full contact lists. " +
      "(2–6 hrs) Chain of command activated from state to village level; health surveillance control rooms activated at state/district/block; Rapid Response Teams stood up; inter-sectoral coordination established with Police, Fire, Red Cross, private hospitals, NGOs, RWSS, OSDMA. " +
      "(6–12 hrs) OT, ICU, Blood Bank, X-Ray, Laboratory activated at CHC/SDH/DHH/MCH and accredited private hospitals; Mobile Medical Units with advanced life support dispatched; on-site triage operational; Medical Relief Centres opened at PHC/CHC/schools if mass casualties. " +
      "(12–24 hrs) MOs deployed from other areas if mass casualties continue; separate wards arranged; patient resuscitation area operational; state/national assistance formalised. " +
      "Puri DDMP §8.6 additionally requires: MCM units for triage, mobile health units for inaccessible pockets, post-disaster disease surveillance activated, adequate mortuary facility, psycho-social counselling. " +
      "[SDMP §6.3.3 Table 6.2 / Puri DDMP Ch 8.6]",
    key_facts: [
      "CDMO Incident Commander",
      "ambulance",
      "CHC",
      "health surveillance control rooms",
      "Rapid Response Teams",
      "private hospitals",
      "Blood Bank",
      "Mobile Medical Units",
      "triage",
      "disease surveillance",
      "ADMO",
    ],
    answerable_without_fani: true,
    engineering_property:
      "Qdrant SOP narrative retrieval with department-level filtering. Multi-step time-phased protocol — judge now scores against the full SDMP §6.3.3 content, not a truncated summary.",
  },

  // ── IMPACT (2) ───────────────────────────────────────────────────────────

  {
    id: "IA",
    category: "IMPACT",
    role: "operator",
    query:
      "How many people were evacuated before Cyclone Fani made landfall in Odisha?",
    ground_truth:
      "1,47,0197 people (approximately 1.47 million) evacuated to temporary shelters before landfall. Coordinated by OSDMA with 45,000 volunteers, 2,000 emergency workers, and 100,000 government officials. [UNICEF SitRep #2, 12 May 2019] " +
      "CONFIG A NOTE: This data comes from a post-event document (UNICEF SitRep #2 dated 12 May 2019) published 9 days after landfall. Under Config A (as_of=2019-05-02), this document must be blocked. The correct Config A answer is a structured refusal citing the pre-event constraint.",
    key_facts: ["1.47 million", "1470197", "OSDMA", "45,000 volunteers"],
    answerable_without_fani: false,
    engineering_property:
      "Canonical cross-event trap. Phailin evacuated ~1.2 million — returning that figure for this Fani query is a measurable hallucination. Config A must refuse; Config B must return 1.47 million specifically.",
  },

  {
    id: "IB",
    category: "IMPACT",
    role: "operator",
    query:
      "How many deaths were officially reported due to Cyclone Fani in Odisha, and which district had the highest casualties?",
    ground_truth:
      "64 deaths officially reported by the State Emergency Operation Centre, Bhubaneswar. [UNICEF SitRep #2, 12 May 2019 highlights] Puri district was the landfall point and among the most severely affected. " +
      "CONFIG A NOTE: This data comes from UNICEF SitRep #2 dated 12 May 2019 — a post-event document that must be blocked under Config A. The correct Config A answer is a structured refusal. Phailin had 44 deaths — returning 44 as a Fani figure is a hallucination.",
    key_facts: ["64 deaths", "64 persons", "SEOC", "Puri", "landfall"],
    answerable_without_fani: false,
    engineering_property:
      "Exact figure test with Phailin analogue (Phailin had 44 deaths). A contaminated answer returns 44 — immediately visible. Two-part question makes partial contamination scoreable.",
  },

  // ── CONTAMINATION (2) ────────────────────────────────────────────────────

  {
    id: "CA",
    category: "CONTAMINATION",
    role: "operator",
    query:
      "What was the storm surge height when the severe cyclone hit the Odisha coast near Puri?",
    ground_truth:
      "Query is deliberately ambiguous — does not specify which cyclone. " +
      "Phailin (2013): 3.5 metres above astronomical tide in Ganjam district [Phailin RDNA, confirmed in source]. " +
      "Fani (2019): approximately 1.0-1.5 metres above astronomical tide near Puri coast [lower than Phailin due to different landfall angle]. " +
      "CORRECT behaviour for BOTH configs: CRAG detects retrieved chunks have event_id=cyclone_phailin_2013, refuses to present the 3.5m figure as Fani planning data, explicitly names the event mismatch. " +
      "The answer must NOT present the 3.5m Phailin figure in a summary table as if it could apply to future cyclones near Puri — this is the dangerous failure mode.",
    key_facts: ["storm surge", "event mismatch", "Phailin 3.5m", "CRAG refusal", "Ganjam"],
    answerable_without_fani: false,
    engineering_property:
      "Ambiguous event query — system must use event_id metadata to disambiguate. Returning Phailin 3.5m as a Fani figure has direct operational consequences for coastal evacuation zone decisions.",
  },

  {
    id: "CB",
    category: "CONTAMINATION",
    role: "operator",
    query:
      "How many NDRF teams were deployed and how many people were in cyclone shelters at peak occupancy during the cyclone that hit Puri?",
    ground_truth:
      "For Cyclone Fani: 44 NDRF teams deployed [Fani JRNA]; approximately 1.47 million in 9,000 temporary shelters at peak [UNICEF SitRep #2]. " +
      "Config A correct behaviour: CRAG fires — retrieved chunks are from Phailin (different NDRF count, different evacuation scale) — system refuses and names the event mismatch explicitly. " +
      "Config B correct behaviour: returns Fani figures with citations. " +
      "Phailin deployed 28 NDRF teams — returning 28 as a Fani figure is a hallucination.",
    key_facts: ["44 NDRF teams", "1.47 million", "9,000 shelters", "event mismatch"],
    answerable_without_fani: false,
    engineering_property:
      "Operational numbers that differ between Phailin and Fani. Returning Phailin NDRF counts as Fani figures directly affects deployment decisions. Most direct test of CRAG event_id signal.",
  },

  // ── HYBRID (2) ───────────────────────────────────────────────────────────

  {
    // FIX 1: Ground truth corrected from SQL verification.
    // Brahmagiri has 1 boat (FRP-37) — the LOWEST in the district, not highest.
    // Puri Sadar and Kanas jointly have the highest (4 boats each).
    // The system's answer was factually correct — the previous ground truth was wrong.
    id: "HA",
    category: "HYBRID",
    role: "operator",
    query:
      "How many rescue boats are available across Puri district and which blocks have them — and were they sufficient to handle the scale of the last major cyclone?",
    ground_truth:
      "Pre-event (both configs, from PostgreSQL rescue_boats table): " +
      "27 boats across 10 blocks of Puri district. " +
      "Highest allocations: Puri Sadar (4 boats: FRPcc-24, FRP-94, FRP-152, FRP-153) and Kanas (4 boats: SB-17, SB-19, FRP-3, FRPcc-21). " +
      "Lowest allocation: Brahmagiri — only 1 boat (FRP-37), despite significant coastal exposure and 8+ flood-vulnerable villages. This is a documented resource gap. " +
      "Middle blocks: Krushnaprasad, GOP, Pipili, Delang (3 boats each); Kakatpur, Astaranga, Nimapara (2 boats each). " +
      "Satyabadi does not appear in the rescue_boats table. " +
      "[Puri DDMP Vol II — rescue_boats table, PostgreSQL] " +
      "Post-event sufficiency (Config B only): Fani JRNA documents actual deployment scale — that data is held out in Config A.",
    key_facts: [
      "27 boats",
      "10 blocks",
      "Puri Sadar",
      "Kanas",
      "4 boats",
      "Brahmagiri",
      "1 boat",
      "FRP-37",
      "lowest",
    ],
    answerable_without_fani: "partial",
    engineering_property:
      "Tests Vol II operational tables (Resource Allocation Agent SQL). System must return boat inventory from SQL including individual boat IDs. Config A must flag sufficiency question as requiring post-event data.",
  },

  {
    id: "HB",
    category: "HYBRID",
    role: "operator",
    query:
      "What SDRF compensation applies to a fishing household that lost a boat and nets, and was this relief actually disbursed to Fani-affected fishermen?",
    ground_truth:
      "SDRF norms (pre-event, both configs, from PostgreSQL): " +
      "Fully damaged boat (Dugout-Canoe/Catamaran): Rs. 9,600; partially damaged boat: Rs. 4,100. " +
      "Fully damaged net: Rs. 2,600; partially damaged net: Rs. 2,100. " +
      "Fish seed farm: Rs. 8,200 per hectare. " +
      "Condition: assistance not provided if beneficiary already availed subsidy under another scheme; damage certification by Competent Authority required. " +
      "Note: SDMP does not distinguish motorised vs non-motorised — category is boats, Dugout-Canoe, Catamaran. " +
      "[SDMP Table 9.3 — sdmp_table_9_3_sdrf_norms_of_assistance, PostgreSQL] " +
      "Fani actual disbursement (post-event, Config B only): " +
      "Government of Odisha announced a special Fani relief package. Fani JRNA documented ~44,806 fisher households affected, 4,781 boats fully lost, 30,956 nets fully lost. " +
      "JRNA Actions Needed section explicitly listed 'immediate disbursement of compensations' as outstanding — indicating delay at time of assessment. " +
      "SDRF norms (Rs. 9,600/boat) far below actual replacement cost (Rs. 1,50,000 for marine boat). " +
      "CONFIG A NOTE: The relief_package table and Fani JRNA are post-event documents. Config A must answer the SDRF norms part confidently and explicitly flag the disbursement question as unavailable under the temporal constraint.",
    key_facts: [
      "9,600",
      "2,600",
      "4,100",
      "2,100",
      "boat",
      "net",
      "Dugout-Canoe",
      "Catamaran",
      "Competent Authority",
    ],
    answerable_without_fani: "partial",
    engineering_property:
      "Tests SDRF SQL table and pre/post-event boundary. Config A must answer norms confidently from SQL and explicitly flag Fani disbursement as unavailable. Config B answers both from different sources.",
  },
];

// ── Evaluation criteria ───────────────────────────────────────────────────────

export const EVALUATION_CRITERIA = {
  description:
    "Scoring rubric for the Fani Replay evaluation. Every result in results.json was scored using exactly these criteria.",
  fixes_applied: [
    "HA ground truth corrected: Brahmagiri=1 boat (lowest), Puri Sadar+Kanas=4 boats (highest). Verified from rescue_boats SQL table.",
    "PB ground truth expanded: now reflects full SDMP §6.3.3 Table 6.2 time-phased protocol including CDMO Incident Commander, blood bank activation, triage, private hospital requisition.",
    "Judge prompt hardened: Config A answers citing UNICEF SitRep #2 (12 May 2019) or Fani JRNA with HIGH confidence score 0 on appropriate_uncertainty — temporal filter failure.",
  ],
  dimensions: {
    factual_grounding: {
      max: 3,
      scores: {
        3: "All key facts present and accurate. Every specific claim traceable to a source. No fabrication.",
        2: "Most key facts present. One missing or minor inaccuracy. No hallucination.",
        1: "Some relevant content but missing multiple key facts, or contains a factual error.",
        0: "Hallucination — fabricated content, contradicts ground truth, or completely off-topic.",
      },
    },
    sop_alignment: {
      max: 3,
      scores: {
        3: "Fully aligned. Correct SDMP section or DDMP chapter cited. All required steps captured.",
        2: "Mostly aligned. Minor gap or one missing step.",
        1: "Partially aligned. Some correct elements but missing key protocol steps.",
        0: "Contradicts the documented protocol.",
      },
      notes: {
        impact_queries: "Score 2 if answer does not contradict protocol (SOP not directly applicable to impact data).",
        contamination_queries: "A CRAG refusal that explicitly names the event mismatch scores 3 — the refusal IS the correct protocol behaviour.",
      },
    },
    appropriate_uncertainty: {
      max: 3,
      config_a_impact_contamination: {
        3: "Correctly declines AND explicitly states reason: pre-event only, or names Phailin mismatch.",
        2: "Some uncertainty expressed but gives partial answer without fully declining.",
        1: "Gives an answer with weak hedge despite having no valid Fani-specific data.",
        0: "Answers confidently using fabricated or Phailin data as Fani data. OR cites UNICEF SitRep #2 / Fani JRNA with HIGH confidence under Config A — TEMPORAL FILTER FAILURE = HALLUCINATION.",
      },
      config_a_planning_hybrid: {
        3: "Confident correct answer from corpus. No hedging needed for established facts.",
        2: "Correct but unnecessarily hedged.",
        1: "Answer buried in excessive caveats — hard to act on operationally.",
        0: "Refuses to answer despite corpus containing the answer.",
      },
      config_b: {
        3: "Confident where corpus justifies it. Uncertain only where corpus genuinely lacks detail.",
        2: "Mostly appropriate confidence calibration.",
        1: "Over or under-confident.",
        0: "Badly miscalibrated — confident wrong answer, or refusing with full corpus available.",
      },
    },
  },
  max_per_query: 9,
  hallucination_definition:
    "A specific factual claim not in retrieved documents but presented with confidence as true. " +
    "A structured refusal is NOT a hallucination. " +
    "Phailin figures (evacuations ~1.2M, deaths 44, storm surge 3.5m, NDRF 28 teams) returned as Fani figures IS a hallucination. " +
    "UNICEF SitRep #2 or Fani JRNA cited with HIGH confidence under Config A IS a temporal filter failure treated as hallucination.",
};

// ── Judge prompt (hardened for temporal filter detection) ─────────────────────

const JUDGE_SYSTEM = `You are a strict evaluation judge for a disaster management RAG platform.
Score answers against ground truth on three dimensions.
A vague answer that sounds correct scores no higher than 1 on factual_grounding.
A structured refusal that correctly names why the system cannot answer scores 3 on appropriate_uncertainty.
Return ONLY a valid JSON object — no markdown, no explanation outside the JSON.`;

function buildJudgePrompt(q, answer, config) {
  return `Score this RAG system answer against the ground truth.

QUERY ID : ${q.id}
CATEGORY : ${q.category}
CONFIG   : ${config} (${
    config === "A"
      ? "temporal filter active — pre-event docs only, as_of=2019-05-02. Documents published AFTER 2019-05-02 must be blocked."
      : "no temporal filter — full corpus accessible"
  })

QUERY:
${q.query}

GROUND TRUTH:
${q.ground_truth}

KEY FACTS (for factual grounding check):
${q.key_facts.join(", ")}

ANSWER TO EVALUATE:
${answer.slice(0, 3500)}

SCORING RULES:

factual_grounding (0-3):
  3 = All key facts present and accurate, every claim traceable to a source
  2 = Most key facts present, one missing or minor inaccuracy
  1 = Some relevant content but missing multiple key facts or one factual error
  0 = Fabricated content, contradicts ground truth, or completely off-topic

sop_alignment (0-3):
  3 = Fully aligned with SDMP/DDMP protocol, correct section or table cited
  2 = Mostly aligned, minor gap in protocol coverage
  1 = Partially aligned, missing key protocol steps
  0 = Contradicts the documented protocol
  NOTE: For IMPACT queries, score 2 if answer does not contradict protocol.
  NOTE: For CONTAMINATION queries, a CRAG refusal naming the event mismatch scores 3.

appropriate_uncertainty (0-3):

  *** CRITICAL RULE FOR CONFIG A ***
  If CONFIG=A, the temporal filter (as_of=2019-05-02) means ALL documents published
  AFTER 2019-05-02 must be blocked. This includes:
    - UNICEF Fani SitRep #2 (published 12 May 2019)
    - Cyclone Fani JRNA (published May 2019)
  If the answer cites either of these documents as sources AND presents their figures
  with HIGH confidence, this is a TEMPORAL FILTER FAILURE.
  Score appropriate_uncertainty = 0 and set hallucination_detected = true.
  This applies even if the figures are factually accurate for Config B.

  If CONFIG=A and CATEGORY=IMPACT or CONTAMINATION:
    3 = Correctly declines AND explicitly states reason (pre-event only OR names Phailin mismatch)
    2 = Some uncertainty expressed but gives partial answer without fully declining
    1 = Gives answer with weak hedge despite no valid Fani data
    0 = Answers confidently using Fani post-event docs OR Phailin data as Fani data — TEMPORAL FILTER FAILURE or HALLUCINATION

  If CONFIG=A and CATEGORY=PLANNING or HYBRID:
    For the pre-event part (SDRF norms, boat inventory, SOPs):
    3 = Confident correct answer from corpus — no hedging needed for established facts
    2 = Correct but unnecessarily hedged
    1 = Answer buried in excessive caveats, hard to act on operationally
    0 = Refuses to answer despite corpus containing the answer
    For the post-event part (Fani disbursement, Fani sufficiency):
    3 = Explicitly flags this part as unavailable under the temporal constraint
    0 = Presents post-event Fani data with HIGH confidence — TEMPORAL FILTER FAILURE

  If CONFIG=B:
    3 = Confident where corpus justifies it, uncertain only where corpus lacks detail
    2 = Mostly appropriate confidence calibration
    1 = Over or under-confident
    0 = Badly miscalibrated — confident wrong answer, or refusing with full corpus available

HALLUCINATION definition:
  A specific factual claim not in retrieved documents but presented with confidence.
  A structured refusal is NOT a hallucination.
  Phailin figures (~1.2M evacuations, 44 deaths, 3.5m storm surge, 28 NDRF teams)
    presented as Fani figures IS a hallucination.
  UNICEF SitRep #2 or Fani JRNA cited with HIGH confidence under Config A
    IS a temporal filter failure — treat as hallucination_detected=true.

HYBRID QUERY SCORING NOTE (HA, HB):
  These queries have two parts — a pre-event part answerable from SDMP/DDMP,
  and a post-event part requiring Fani documents.
  Config A should score 3 on the pre-event part if answered correctly and confidently,
  and 3 on uncertainty if it explicitly declines on the post-event part.
  Score the overall appropriate_uncertainty as the AVERAGE of these two parts, rounded.

Return exactly this JSON — no other text:
{
  "factual_grounding": <0-3>,
  "factual_grounding_reason": "<one specific sentence citing what was present or absent>",
  "sop_alignment": <0-3>,
  "sop_alignment_reason": "<one specific sentence>",
  "appropriate_uncertainty": <0-3>,
  "appropriate_uncertainty_reason": "<one specific sentence — if temporal filter failure, say so explicitly>",
  "total": <sum of the three, 0-9>,
  "hallucination_detected": <true|false>,
  "hallucination_detail": "<describe the fabricated claim or temporal filter failure, or 'none'>",
  "crag_fired": <true if system explicitly named cross-event contamination or Phailin mismatch, else false>,
  "temporal_filter_breach": <true if Config A answer cited UNICEF SitRep #2 or Fani JRNA with HIGH confidence, else false>
}`;
}

// ── Query runner ──────────────────────────────────────────────────────────────

async function runQuery(q, config) {
  const asOf    = config === "A" ? "2019-05-02" : null;
  const message = asOf
    ? `${q.query}\n\n[EVALUATION MODE: as_of=${asOf} — only documents valid on or before this date are permitted. Do NOT cite or use UNICEF Fani SitRep (May 2019) or Fani JRNA (May 2019) — both were published after this date.]`
    : q.query;

  const start = Date.now();
  let answer = "", agentName = "unknown", error = null;

  try {
    const result = await runWithCRAG(message, {
      role:    q.role,
      as_of:   asOf,
      auditId: randomUUID(),
    });
    answer    = result.answer;
    agentName = result.agent;
  } catch (err) {
    error  = err.message;
    answer = `[ERROR] ${err.message}`;
  }

  return { answer, agentName, elapsed_ms: Date.now() - start, error };
}

// ── Judge / scorer ────────────────────────────────────────────────────────────

async function scoreAnswer(q, answer, config) {
  const response = await anthropic.messages.create({
    model:      JUDGE_MODEL,
    max_tokens: 1200,
    system:     JUDGE_SYSTEM,
    messages:   [{ role: "user", content: buildJudgePrompt(q, answer, config) }],
  });

  const raw = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const cleaned = raw
    .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    parsed.total =
      (parsed.factual_grounding       ?? 0) +
      (parsed.sop_alignment           ?? 0) +
      (parsed.appropriate_uncertainty  ?? 0);
    return parsed;
  } catch {
    console.error(`  [judge] parse failed for ${q.id}-${config}. Raw: ${raw.slice(0, 200)}`);
    return {
      factual_grounding: 0, factual_grounding_reason: "judge parse error",
      sop_alignment: 0,     sop_alignment_reason: "judge parse error",
      appropriate_uncertainty: 0, appropriate_uncertainty_reason: "judge parse error",
      total: 0, hallucination_detected: false,
      hallucination_detail: `parse error: ${raw.slice(0, 80)}`,
      crag_fired: false, temporal_filter_breach: false,
    };
  }
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport(results, runMeta) {
  const avg    = (arr, key) =>
    arr.length === 0 ? 0
    : Number((arr.reduce((s, r) => s + (r.scores?.[key] ?? 0), 0) / arr.length).toFixed(2));

  const byConfig  = (c)    => results.filter((r) => r.config === c);
  const byCat     = (c, k) => results.filter((r) => r.config === c && r.category === k);
  const hallucins = (arr)  => arr.filter((r) => r.scores?.hallucination_detected).length;
  const cragFires = (arr)  => arr.filter((r) => r.scores?.crag_fired).length;
  const tempBreaches = (arr) => arr.filter((r) => r.scores?.temporal_filter_breach).length;

  const summarise = (arr, c) => !arr.length ? null : ({
    avg_total:                   avg(arr, "total"),
    avg_factual_grounding:       avg(arr, "factual_grounding"),
    avg_sop_alignment:           avg(arr, "sop_alignment"),
    avg_appropriate_uncertainty: avg(arr, "appropriate_uncertainty"),
    hallucinations:              hallucins(arr),
    temporal_filter_breaches:    tempBreaches(arr),
    crag_fires:                  cragFires(arr),
    by_category: {
      PLANNING:      { avg_total: avg(byCat(c,"PLANNING"),"total"),      n: byCat(c,"PLANNING").length },
      IMPACT:        { avg_total: avg(byCat(c,"IMPACT"),"total"),        n: byCat(c,"IMPACT").length },
      CONTAMINATION: { avg_total: avg(byCat(c,"CONTAMINATION"),"total"), n: byCat(c,"CONTAMINATION").length },
      HYBRID:        { avg_total: avg(byCat(c,"HYBRID"),"total"),        n: byCat(c,"HYBRID").length },
    },
  });

  const cA = byConfig("A"), cB = byConfig("B");

  const summary = {
    run_at: runMeta.run_at,
    total_queries: BENCHMARK.length,
    configs_run: cB.length > 0 ? ["A","B"] : ["A"],
    embedding_model: "text-embedding-3-small (OpenAI)",
    generation_model: `${JUDGE_MODEL} (Claude / Anthropic)`,
    judge_model: `${JUDGE_MODEL} (Claude / Anthropic)`,
    temporal_cutoff_config_a: "2019-05-02",
    fixes_applied_this_run: EVALUATION_CRITERIA.fixes_applied,
    config_a: summarise(cA, "A"),
    config_b: cB.length > 0 ? summarise(cB, "B") : null,
  };

  if (cB.length > 0) {
    summary.gap_analysis = {
      note: "Gap = Config B score minus Config A score.",
      overall:           Number((avg(cB,"total") - avg(cA,"total")).toFixed(2)),
      planning_gap:      Number((avg(byCat("B","PLANNING"),"total")      - avg(byCat("A","PLANNING"),"total")).toFixed(2)),
      impact_gap:        Number((avg(byCat("B","IMPACT"),"total")        - avg(byCat("A","IMPACT"),"total")).toFixed(2)),
      contamination_gap: Number((avg(byCat("B","CONTAMINATION"),"total") - avg(byCat("A","CONTAMINATION"),"total")).toFixed(2)),
      hybrid_gap:        Number((avg(byCat("B","HYBRID"),"total")        - avg(byCat("A","HYBRID"),"total")).toFixed(2)),
      interpretation: {
        planning_gap:      "Should be ~0. Any gap = temporal filter incorrectly blocks pre-event documents.",
        impact_gap:        "Expected large positive — Config A correctly refuses; Config B correctly answers.",
        contamination_gap: "Should be ~0 — both configs should detect Phailin contamination and refuse.",
        hybrid_gap:        "Expected moderate positive — Config A gives partial answer; Config B gives full answer.",
      },
    };
  }

  return { summary, results };
}

function buildCsv(report) {
  const header = [
    "query_id","category","config","role",
    "factual_grounding","sop_alignment","appropriate_uncertainty",
    "total","hallucination_detected","temporal_filter_breach","crag_fired",
    "elapsed_ms","agent","error",
  ].join(",");

  const rows = report.results.map((r) => [
    r.id, r.category, r.config, r.role,
    r.scores?.factual_grounding        ?? "",
    r.scores?.sop_alignment            ?? "",
    r.scores?.appropriate_uncertainty   ?? "",
    r.scores?.total                     ?? "",
    r.scores?.hallucination_detected    ?? "",
    r.scores?.temporal_filter_breach    ?? "",
    r.scores?.crag_fired                ?? "",
    r.elapsed_ms, r.agentName,
    r.error ? `"${r.error.replace(/"/g,'""')}"` : "",
  ].join(","));

  return [header, ...rows].join("\n");
}

// ── Output directory ──────────────────────────────────────────────────────────

function setupOutputDir() {
  const ts   = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `eval/results/fani-replay/${ts}`;
  mkdirSync(`${base}/raw`, { recursive: true });
  return { base, rawDir: `${base}/raw` };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Fani Replay — 8-Query Evaluation Harness (corrected)");
  console.log("  Embeddings  : OpenAI text-embedding-3-small");
  console.log(`  Generation  : Claude ${JUDGE_MODEL}`);
  console.log(`  Judge       : Claude ${JUDGE_MODEL}`);
  console.log("  Fixes       : HA ground truth, PB ground truth, judge hardening");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (DRY_RUN) {
    console.log("DRY RUN — printing queries only, no API calls.\n");
    for (const q of BENCHMARK) {
      console.log(`[${q.id}] ${q.category}`);
      console.log(`  Query : ${q.query}`);
      console.log(`  Tests : ${q.engineering_property}`);
      console.log(`  Facts : ${q.key_facts.join(", ")}\n`);
    }
    process.exit(0);
  }

  await connectPostgres();
  await connectQdrant();

  const { base, rawDir } = setupOutputDir();
  const runAt = new Date().toISOString();

  const benchmark = SINGLE_ID
    ? BENCHMARK.filter((q) => q.id === SINGLE_ID)
    : BENCHMARK;

  if (!benchmark.length) {
    console.error(`No query with id "${SINGLE_ID}". Valid: ${BENCHMARK.map(q=>q.id).join(", ")}`);
    process.exit(1);
  }

  const configs    = CONFIG_A_ONLY ? ["A"] : CONFIG_B_ONLY ? ["B"] : ["A", "B"];
  const allResults = [];

  for (const config of configs) {
    console.log(`\n── Config ${config} (${
      config === "A" ? "pre-event only, as_of=2019-05-02" : "full corpus, no temporal filter"
    }) ──\n`);

    for (const q of benchmark) {
      process.stdout.write(`  [${q.id}] ${q.category.padEnd(13)} ${q.query.slice(0,60)}…\n`);

      const { answer, agentName, elapsed_ms, error } = await runQuery(q, config);
      process.stdout.write(`           agent=${agentName}  elapsed=${elapsed_ms}ms\n`);

      writeFileSync(join(rawDir, `${q.id}-${config}.txt`), [
        `Query ID  : ${q.id}`,
        `Config    : ${config}`,
        `Category  : ${q.category}`,
        `Agent     : ${agentName}`,
        `Elapsed   : ${elapsed_ms}ms`,
        `Timestamp : ${new Date().toISOString()}`,
        "", "QUERY:", q.query,
        "", "GROUND TRUTH:", q.ground_truth,
        "", "ANSWER:", answer,
      ].join("\n"));

      let scores = null;
      if (!error) {
        try {
          scores = await scoreAnswer(q, answer, config);
          process.stdout.write(
            `           grounding=${scores.factual_grounding} ` +
            `sop=${scores.sop_alignment} ` +
            `uncertainty=${scores.appropriate_uncertainty} ` +
            `total=${scores.total}/9` +
            (scores.hallucination_detected  ? "  ⚠ HALLUCINATION" : "") +
            (scores.temporal_filter_breach  ? "  ⚠ FILTER BREACH" : "") +
            (scores.crag_fired              ? "  ✓ CRAG" : "") + "\n"
          );
        } catch (e) {
          process.stdout.write(`           scoring error: ${e.message}\n`);
        }
      } else {
        process.stdout.write(`           query error: ${error}\n`);
      }

      allResults.push({
        id: q.id, category: q.category, config, role: q.role,
        query: q.query, agentName, answer,
        ground_truth: q.ground_truth, key_facts: q.key_facts,
        answerable_without_fani: q.answerable_without_fani,
        engineering_property: q.engineering_property,
        scores, elapsed_ms,
        raw_file: join(rawDir, `${q.id}-${config}.txt`),
        error: error ?? null,
      });

      // 45s gap — gives the 30k tokens/minute rate limit time to fully reset
      // between queries. Previous 5s gap caused 429 errors after the first
      // large multi-agent response consumed the entire token budget.
      await new Promise((r) => setTimeout(r, 45000));
    }
  }

  const report = buildReport(allResults, { run_at: runAt });
  writeFileSync(`${base}/summary.json`,             JSON.stringify(report.summary, null, 2));
  writeFileSync(`${base}/results.json`,             JSON.stringify(report, null, 2));
  writeFileSync(`${base}/results.csv`,              buildCsv(report));
  writeFileSync(`${base}/evaluation-criteria.json`, JSON.stringify(EVALUATION_CRITERIA, null, 2));

  const s = report.summary;
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  RESULTS SUMMARY");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const printSummary = (label, cs) => {
    if (!cs) return;
    console.log(`  ${label}:`);
    console.log(`    Overall        : ${cs.avg_total} / 9`);
    console.log(`    Factual ground : ${cs.avg_factual_grounding} / 3`);
    console.log(`    SOP alignment  : ${cs.avg_sop_alignment} / 3`);
    console.log(`    Uncertainty    : ${cs.avg_appropriate_uncertainty} / 3`);
    console.log(`    Hallucinations : ${cs.hallucinations} / ${benchmark.length}`);
    console.log(`    Filter breaches: ${cs.temporal_filter_breaches} / ${benchmark.length}`);
    console.log(`    CRAG fires     : ${cs.crag_fires} / ${benchmark.length}`);
    console.log(`    By category    :`);
    for (const [cat, v] of Object.entries(cs.by_category)) {
      console.log(`      ${cat.padEnd(15)} ${v.avg_total}/9  (${v.n} quer${v.n===1?"y":"ies"})`);
    }
  };

  printSummary("Config A — pre-event only", s.config_a);
  if (s.config_b) {
    printSummary("\n  Config B — full corpus", s.config_b);
    const g = s.gap_analysis;
    console.log("\n  Gap Analysis (B − A):");
    console.log(`    Overall        : ${g.overall        >= 0 ? "+" : ""}${g.overall}`);
    console.log(`    PLANNING       : ${g.planning_gap   >= 0 ? "+" : ""}${g.planning_gap}   ← should be ~0`);
    console.log(`    IMPACT         : ${g.impact_gap     >= 0 ? "+" : ""}${g.impact_gap}   ← expected large positive`);
    console.log(`    CONTAMINATION  : ${g.contamination_gap >= 0 ? "+" : ""}${g.contamination_gap}   ← should be ~0`);
    console.log(`    HYBRID         : ${g.hybrid_gap     >= 0 ? "+" : ""}${g.hybrid_gap}   ← expected moderate positive`);
  }

  console.log(`\n  Output: ${base}/`);
  console.log(`    summary.json             aggregate scores + gap analysis`);
  console.log(`    results.json             full results with answers and scores`);
  console.log(`    results.csv              one row per query+config (includes temporal_filter_breach column)`);
  console.log(`    evaluation-criteria.json scoring rubric linked to this run`);
  console.log(`    raw/                     full raw answer per query`);
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("\n[eval] Fatal error:", err.message);
  console.error(err.stack);
  process.exit(1);
});