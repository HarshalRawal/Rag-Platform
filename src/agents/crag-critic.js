// src/agents/crag-critic.js
//
// CRAG (Corrective RAG) Critic — wraps runTriage(), inspects answer quality,
// retries with a reformulated query if retrieval was poor.
//
// DECISION FLOW:
//   runTriage()
//     ↓
//   extractSignals()   — parse confidence score, event names, zero-retrieval flag
//     ↓
//   makeCRAGDecision() — PASS | RETRY | DECLINE
//     ↓
//   PASS    → return answer as-is
//   RETRY   → reformulate query, run triage again, re-evaluate
//   DECLINE → return structured refusal (never fabricate)
//
// SCORE THRESHOLDS (from model-config.js):
//   GOOD  >= 0.62  → immediate PASS
//   SOFT  >= 0.55  → PASS on retry, RETRY on first attempt
//   HARD  >= 0.45  → RETRY on first attempt, DECLINE after retry
//   below HARD     → DECLINE (even on first attempt if very low)

import { runTriage } from "./triage-agent.js";
import {
  CRAG_HARD_THRESHOLD,
  CRAG_SOFT_THRESHOLD,
  CRAG_GOOD_THRESHOLD,
} from "./model-config.js";

// Known cyclone event name aliases — used for cross-event contamination detection
const EVENT_NAMES = {
  fani:    ["fani", "fani 2019", "cyclone fani"],
  phailin: ["phailin", "phailin 2013", "cyclone phailin"],
};

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Runs the full triage pipeline and evaluates answer quality.
 * Retries once with a reformulated query if retrieval quality is poor.
 *
 * @param {string} message        - The user's query
 * @param {object} [context]      - Optional context
 * @param {string} [context.as_of]- ISO date for temporal constraint evaluation
 * @returns {Promise<CRAGResult>}
 */
export async function runWithCRAG(message, context = {}) {
  const { as_of = null } = context;

  // First attempt
  const agentResult = await runAgentSafe(message);
  const signals     = extractSignals(agentResult.answer, message);
  const decision    = makeCRAGDecision(signals, message, agentResult.answer, false);

  if (decision.action === "PASS") {
    return {
      answer:   agentResult.answer,
      agent:    agentResult.agentName,
      mode:     agentResult.mode,
      plan:     agentResult.plan,
      rewrite:  agentResult.rewrite,
      crag:     { action: "PASS", reason: decision.reason, signals },
      retried:  false,
    };
  }

  if (decision.action === "RETRY") {
    const reformulated  = reformulateMessage(message, decision.reformulation);
    const retryResult   = await runAgentSafe(reformulated);
    const retrySignals  = extractSignals(retryResult.answer, message);
    const retryDecision = makeCRAGDecision(retrySignals, message, retryResult.answer, true);

    if (retryDecision.action === "PASS") {
      return {
        answer:  retryResult.answer,
        agent:   retryResult.agentName,
        mode:    retryResult.mode,
        plan:    retryResult.plan,
        rewrite: retryResult.rewrite,
        crag:    { action: "RETRY→PASS", reason: decision.reason, signals: retrySignals },
        retried: true,
      };
    }

    return {
      answer:  buildDeclineResponse(message, decision, retrySignals, as_of),
      agent:   retryResult.agentName,
      mode:    retryResult.mode,
      plan:    retryResult.plan,
      rewrite: retryResult.rewrite,
      crag:    { action: "RETRY→DECLINE", reason: decision.reason, signals: retrySignals },
      retried: true,
    };
  }

  // DECLINE on first attempt (very low score, no retry warranted)
  return {
    answer:  buildDeclineResponse(message, decision, signals, as_of),
    agent:   agentResult.agentName,
    mode:    agentResult.mode,
    plan:    agentResult.plan,
    rewrite: agentResult.rewrite,
    crag:    { action: "DECLINE", reason: decision.reason, signals },
    retried: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Runs runTriage() and normalises the result into a flat shape.
 * Handles the richer return object from the updated triage pipeline
 * (which now includes mode, plan, rewrite alongside answer and agentName).
 */
async function runAgentSafe(message) {
  try {
    const result = await runTriage(message);
    return {
      answer:    result.answer    ?? "",
      agentName: result.agentName ?? "unknown",
      mode:      result.mode      ?? 1,
      plan:      result.plan      ?? null,
      rewrite:   result.rewrite   ?? null,
    };
  } catch (err) {
    console.error(`[crag] runTriage failed: ${err.message}`);
    return {
      answer:    `ERROR: ${err.message}`,
      agentName: "unknown",
      mode:      1,
      plan:      null,
      rewrite:   null,
    };
  }
}

/**
 * Parses the agent's answer to extract quality signals.
 * Reads the CONFIDENCE line that every specialist agent appends.
 */
function extractSignals(answer, originalQuery) {
  const signals = {
    topScore:           null,
    avgScore:           null,
    sources:            null,
    isDbOnly:           false,
    isZeroRetrieval:    false,
    confidenceLevel:    null,
    agentDeclined:      false,
    wrongEventDetected: false,
    queriedEvent:       null,
    retrievedEvent:     null,
  };

  if (!answer) return signals;

  // Parse the CONFIDENCE line appended by all specialist agents:
  // "CONFIDENCE: HIGH (topScore=0.71, avgScore=0.63, sources=4)"
  // "CONFIDENCE: HIGH (source=database, rows_returned=15)"
  const confMatch = answer.match(/CONFIDENCE:\s*(HIGH|MEDIUM|LOW)[^\n]*\(([^)]+)\)/i);
  if (confMatch) {
    signals.confidenceLevel = confMatch[1].toUpperCase();

    for (const pair of confMatch[2].split(",")) {
      const [rawKey, rawVal] = pair.trim().split("=");
      if (!rawKey || rawVal === undefined) continue;
      const key = rawKey.trim();
      const val = rawVal.trim();
      const num = parseFloat(val);

      if (key === "topScore")                          signals.topScore = isNaN(num) ? null : num;
      if (key === "avgScore")                          signals.avgScore = isNaN(num) ? null : num;
      if (key === "sources")                           signals.sources  = isNaN(num) ? null : num;
      if (key === "source" && val === "database")      signals.isDbOnly = true;
      if (key === "rows_returned" && !isNaN(num) && num > 0) signals.isDbOnly = true;
    }
  }

  // Zero retrieval: topScore of exactly 0 means Qdrant returned nothing
  if (signals.topScore === 0) signals.isZeroRetrieval = true;

  // Agent declined: explicit "I cannot find" language in the answer
  const lower = answer.toLowerCase();
  if (lower.includes("i cannot find") || lower.includes("not available in the")) {
    signals.agentDeclined = true;
  }

  // Cross-event contamination check:
  // If the query asks about Fani but the answer cites Phailin (or vice versa), flag it.
  const queryLower = originalQuery.toLowerCase();
  for (const [event, aliases] of Object.entries(EVENT_NAMES)) {
    if (aliases.some((a) => queryLower.includes(a))) signals.queriedEvent   = event;
    if (aliases.some((a) => lower.includes(a)))       signals.retrievedEvent = event;
  }
  if (
    signals.queriedEvent &&
    signals.retrievedEvent &&
    signals.queriedEvent !== signals.retrievedEvent
  ) {
    signals.wrongEventDetected = true;
  }

  return signals;
}

/**
 * Decides whether to PASS, RETRY, or DECLINE based on extracted signals.
 */
function makeCRAGDecision(signals, originalMessage, answer, isRetry) {
  // Database-grounded answers are always trusted — no vector score to check
  if (signals.isDbOnly) {
    return { action: "PASS", reason: "database answer — grounded by definition" };
  }

  // Agent correctly declined (low confidence, explicit refusal) — respect it
  if (signals.agentDeclined && signals.confidenceLevel === "LOW") {
    return { action: "PASS", reason: "agent correctly declined — no fabrication" };
  }

  // Strong retrieval with no event mismatch → immediate pass
  if (
    signals.topScore !== null &&
    signals.topScore >= CRAG_GOOD_THRESHOLD &&
    !signals.wrongEventDetected
  ) {
    return { action: "PASS", reason: `topScore=${signals.topScore} ≥ GOOD_THRESHOLD` };
  }

  // Wrong event retrieved → retry, but DO NOT restrict to event-only documents.
  // FM-1 FIX: the original instruction "Search only for Fani documents" excluded
  // pre-event planning docs (SDMP, DDMP) that have no event_id — those docs are
  // exactly what PB needs. Broadening is safer than restricting.
  if (signals.wrongEventDetected && !isRetry) {
    return {
      action:        "RETRY",
      reason:        "wrong-event retrieval detected",
      reformulation: {
        type:        "event_clarify",
        instruction: `Focus on ${signals.queriedEvent} event data and pre-event planning documents. Do not present ${signals.retrievedEvent} data as ${signals.queriedEvent} data.`,
      },
    };
  }

  // Zero retrieval → retry with broader terms
  if (signals.isZeroRetrieval && !isRetry) {
    return {
      action:        "RETRY",
      reason:        "zero retrieval — no chunks returned",
      reformulation: {
        type:        "broaden",
        instruction: "Use shorter, more general search terms.",
      },
    };
  }

  // Score below hard threshold
  if (signals.topScore !== null && signals.topScore < CRAG_HARD_THRESHOLD) {
    if (isRetry) {
      return { action: "DECLINE", reason: `topScore=${signals.topScore} still below HARD_THRESHOLD after retry` };
    }
    return {
      action:        "RETRY",
      reason:        `topScore=${signals.topScore} below HARD_THRESHOLD`,
      reformulation: {
        type:        "keyword_fallback",
        instruction: "Search with 3–4 key nouns only.",
      },
    };
  }

  // Score below soft threshold (but above hard)
  if (signals.topScore !== null && signals.topScore < CRAG_SOFT_THRESHOLD) {
    if (isRetry) {
      return { action: "DECLINE", reason: `topScore=${signals.topScore} still below SOFT_THRESHOLD after retry` };
    }
    return {
      action:        "RETRY",
      reason:        `topScore=${signals.topScore} below SOFT_THRESHOLD`,
      reformulation: {
        type:        "synonym_expand",
        instruction: "Try alternative terminology for the same concept.",
      },
    };
  }

  // Wrong event still present after retry
  if (signals.wrongEventDetected && isRetry) {
    return { action: "DECLINE", reason: "wrong-event retrieval persisted after retry" };
  }

  return { action: "PASS", reason: "default pass" };
}

/**
 * Reformulates the original message based on the CRAG retry instruction.
 * Appends a CRAG INSTRUCTION tag that the specialist agents' search rules honour.
 */
function reformulateMessage(originalMessage, reformulation) {
  // Strip any previous CRAG instruction tags before appending a new one
  const base = originalMessage.replace(/\[CRAG INSTRUCTION:.*?\]/gs, "").trim();

  let reformed = base;
  if (reformulation.type === "broaden") {
    // Remove temporal qualifiers that may be narrowing results unnecessarily
    reformed = base
      .replace(/\b(before|during|after)\s+(cyclone\s+)?(fani|phailin)\b/gi, "")
      .replace(/\b\d{4}\b/g, "")
      .trim();
  }
  // event_clarify: keep query as-is, just append the clarifying instruction.
  // Do NOT strip the query text — the agent needs the full question to retrieve
  // planning documents (SDMP, DDMP) that have no event_id metadata.

  return `${reformed}\n\n[CRAG INSTRUCTION: ${reformulation.instruction}]`;
}

/**
 * Builds a structured decline response.
 * Never fabricates — always explains why it cannot answer.
 */
function buildDeclineResponse(originalMessage, decision, signals, as_of) {
  const topScore = signals.topScore ?? 0;
  const avgScore = signals.avgScore ?? 0;

  // Wrong event: was looking for Fani, got Phailin (or vice versa)
  if (signals.wrongEventDetected) {
    const eventName = signals.queriedEvent
      ? `Cyclone ${signals.queriedEvent.charAt(0).toUpperCase() + signals.queriedEvent.slice(1)}`
      : "this cyclone event";
    return (
      `I was unable to find sufficient information specifically about ${eventName} ` +
      `in the available documents. The retrieved content relates to a different event.\n\n` +
      `CONFIDENCE: LOW (topScore=${topScore}, crag_action=DECLINE, reason=wrong_event)`
    );
  }

  // Temporal constraint: query asks about post-event data, but as_of cutoff excludes it
  if (as_of) {
    return (
      `I cannot answer this from documents available on or before ${as_of}. ` +
      `The information requested relates to post-event data that falls outside ` +
      `the temporal constraint.\n\n` +
      `CONFIDENCE: LOW (topScore=${topScore}, crag_action=DECLINE, as_of=${as_of})`
    );
  }

  // General low-quality retrieval
  return (
    `The retrieved context did not meet the confidence threshold for a reliable answer. ` +
    `Please rephrase your question with more specific terms — for example, include ` +
    `the block name, event name (Cyclone Fani or Cyclone Phailin), or the specific ` +
    `resource or procedure you are asking about.\n\n` +
    `CONFIDENCE: LOW (topScore=${topScore}, avgScore=${avgScore}, crag_action=DECLINE)`
  );
}

/**
 * @typedef {Object} CRAGResult
 * @property {string} answer  - Final answer or structured decline response
 * @property {string} agent   - Agent name(s) used
 * @property {number} mode    - Execution mode: 1 | 2 | 3
 * @property {object} crag    - CRAG decision metadata: { action, reason, signals }
 * @property {boolean} retried - Whether a retry was attempted
 */