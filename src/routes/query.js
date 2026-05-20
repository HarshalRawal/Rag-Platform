// src/routes/query.js
//
// POST /api/query
//
// Request body:
// {
//   "query":   string,                    // required
//   "role":    "citizen"|"operator",      // optional, default "citizen"
//   "as_of":   "YYYY-MM-DD",              // optional — temporal filter
//   "stream":  boolean                    // optional, default false (reserved)
// }
//
// Response:
// {
//   "ok":          true,
//   "answer":      string,
//   "agent":       string,               // agent name(s) — "+" parallel, "→" sequential
//   "mode":        1|2|3,               // 1=single, 2=parallel, 3=sequential
//   "agents_used": string[],            // all agents that contributed
//   "confidence":  { level, ... },
//   "crag":        { action, reason, retried },
//   "rewrite":     { was_rewritten, rewritten_query, provider } | null,
//   "routing":     { reasoning, query_complexity } | null,
//   "audit_id":    string,
//   "elapsed_ms":  number
// }

import express          from "express";
import { randomUUID }   from "crypto";
import { query as pgQuery } from "../config/postgres.js";
import { runWithCRAG }  from "../agents/crag-critic.js";
import { setSessionAsOf } from "../agents/tools.js";

const router = express.Router();

router.post("/query", async (req, res) => {
  const start = Date.now();

  const { query, role = "citizen", as_of = null, stream = false } = req.body ?? {};

  // ── Input validation ────────────────────────────────────────────────────────
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ ok: false, error: "query is required" });
  }
  if (!["citizen", "operator"].includes(role)) {
    return res.status(400).json({ ok: false, error: "role must be 'citizen' or 'operator'" });
  }
  if (as_of && !/^\d{4}-\d{2}-\d{2}$/.test(as_of)) {
    return res.status(400).json({ ok: false, error: "as_of must be YYYY-MM-DD" });
  }

  const auditId = randomUUID();

  // ── Build the message passed to the agent pipeline ──────────────────────────
  // Temporal and role context is appended as structured tags that specialist
  // agent prompts and the CRAG evaluator explicitly look for.
  let userMessage = query.trim();
  if (as_of) {
    userMessage += `\n\n[EVALUATION MODE: as_of=${as_of} — only use documents valid on or before this date]`;
  }
  if (role === "operator") {
    userMessage += `\n[CALLER ROLE: operator — operator_only documents are accessible]`;
  }

  try {
    // Enforce temporal constraint at the Qdrant tool layer.
    // This blocks evaluation_ground_truth chunks (Fani JRNA, UNICEF SitRep)
    // regardless of whether agents pass asOf in their search_qdrant calls.
    setSessionAsOf(as_of);

    const result = await runWithCRAG(userMessage, { role, as_of, auditId });

    // Clear session asOf after pipeline completes — prevents temporal constraint
    // from leaking into subsequent requests that don't pass as_of.
    setSessionAsOf(null);

    const answer    = result.answer;
    const agentName = result.agent;
    const mode      = result.mode ?? 1;
    const crag      = result.crag;

    // ── Derive agents_used from agentName ─────────────────────────────────────
    // agentName format from triage-agent.js:
    //   Mode 1: "DisasterResponseAgent"
    //   Mode 2: "DisasterResponseAgent+ResourceAllocationAgent"
    //   Mode 4: "DisasterResponseAgent→ResourceAllocationAgent"
    // Split on both separators to get a clean array for all modes.
    const agentsUsed = agentName
      ? agentName.split(/[+→]/).map((s) => s.trim()).filter(Boolean)
      : [];

    // ── Extract optional metadata from the triage plan ────────────────────────
    // crag-critic passes plan and rewrite through in its result object.
    // These are useful for the operator dashboard and debugging.
    const rewriteMeta  = result.rewrite
      ? {
          was_rewritten:   result.rewrite.was_rewritten  ?? false,
          rewritten_query: result.rewrite.rewritten_query ?? null,
          provider:        result.rewrite.provider        ?? null,
        }
      : null;

    const routingMeta = result.plan
      ? {
          reasoning:        result.plan.reasoning        ?? null,
          query_complexity: result.plan.query_complexity ?? null,
        }
      : null;

    const confidence = parseConfidence(answer);
    const elapsed    = Date.now() - start;

    // ── Audit log (fire-and-forget — never block the response) ───────────────
    writeAuditLog({
      auditId,
      query:      query.trim(),
      role,
      as_of,
      agentName,
      answer,
      confidence,
      cragAction: crag?.action ?? "UNKNOWN",
      elapsedMs:  elapsed,
      mode,
    }).catch((err) => {
      console.error("[query] Audit log write failed:", err.message);
    });

    return res.json({
      ok:          true,
      answer,
      agent:       agentName,
      mode,
      agents_used: agentsUsed,
      confidence,
      crag: {
        action:  crag?.action  ?? "UNKNOWN",
        reason:  crag?.reason  ?? null,
        retried: crag?.retried ?? false,
      },
      rewrite:    rewriteMeta,
      routing:    routingMeta,
      audit_id:   auditId,
      elapsed_ms: elapsed,
    });

  } catch (err) {
    setSessionAsOf(null); // ensure temporal constraint is cleared on error
    console.error("[query] Agent run failed:", err.message);
    return res.status(500).json({
      ok:       false,
      error:    "Agent failed to process query",
      detail:   process.env.NODE_ENV !== "production" ? err.message : undefined,
      audit_id: auditId,
    });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parses the CONFIDENCE line that every specialist agent appends to its answer.
 *
 * Handles all markdown variants agents produce:
 *   CONFIDENCE: HIGH (topScore=0.71, avgScore=0.63, sources=4)
 *   CONFIDENCE: **HIGH** (source=database, rows_returned=15)
 *   **CONFIDENCE:** HIGH (tables_queried=1, rows_found=1, gaps=0)
 *   **CONFIDENCE: HIGH** (topScore=0.71)
 */
function parseConfidence(answer) {
  // Strip all bold markers before matching so every variant is handled uniformly
  const cleaned = answer?.replace(/\*\*/g, "") ?? "";
  const match = cleaned.match(
    /CONFIDENCE:\s*(HIGH|MEDIUM|LOW)[^\n]*\(([^)]+)\)/i
  );
  if (!match) return { level: "UNKNOWN" };

  const level   = match[1].toUpperCase();
  const details = {};

  for (const pair of match[2].split(",")) {
    const [k, v] = pair.trim().split("=");
    if (k && v !== undefined) {
      const num = parseFloat(v);
      details[k.trim()] = isNaN(num) ? v.trim() : num;
    }
  }
  return { level, ...details };
}

/**
 * Writes a query audit record to Postgres.
 * Called fire-and-forget — never blocks the response.
 * Table and columns are created at boot via initAuditLog() — not here.
 */
async function writeAuditLog({
  auditId, query, role, as_of, agentName,
  answer, confidence, cragAction, elapsedMs, mode,
}) {
  await pgQuery(
    `INSERT INTO audit_log
       (audit_id, query, role, as_of, agent_name, answer,
        confidence, crag_action, elapsed_ms, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (audit_id) DO NOTHING`,
    [
      auditId,
      query,
      role,
      as_of ?? null,
      agentName,
      answer,
      JSON.stringify(confidence),
      cragAction ?? "UNKNOWN",
      elapsedMs,
      mode,
    ]
  );
}

/**
 * Creates the audit_log table and adds any missing columns.
 * Call once at server startup — not on every request.
 */
export async function initAuditLog() {
  // Check if the table already exists — skip all DDL if it does.
  // This avoids running 9 unnecessary DB calls on every restart.
  const { rows } = await pgQuery(`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'audit_log'
  `);

  if (rows && rows.length > 0) {
    console.log("[boot] audit_log table already exists — skipping migration.");
    return;
  }

  // First boot — create table and add all columns
  await pgQuery(`
    CREATE TABLE IF NOT EXISTS audit_log (
      audit_id     TEXT PRIMARY KEY,
      created_at   TIMESTAMPTZ DEFAULT NOW(),
      query        TEXT,
      role         TEXT,
      as_of        DATE,
      agent_name   TEXT,
      answer       TEXT,
      confidence   JSONB,
      crag_action  TEXT,
      elapsed_ms   INTEGER,
      mode         INTEGER
    )
  `);
  for (const sql of [
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS role        TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS as_of       DATE`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS agent_name  TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS answer      TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS confidence  JSONB`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS crag_action TEXT`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS elapsed_ms  INTEGER`,
    `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS mode        INTEGER`,
  ]) { await pgQuery(sql).catch(() => {}); }
  console.log("[boot] audit_log table created.");
}

export default router;