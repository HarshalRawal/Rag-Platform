// src/agents/model-config.js
//
// SINGLE SOURCE OF TRUTH for all model names and token budgets.
// Every file that needs a model string or token limit imports from here.
//
// To switch models globally: change this file only.
//
// ── MODEL ROLES ───────────────────────────────────────────────────────────────
//
//   SONNET  → specialist agents (deep reasoning, tool use, complex queries)
//   HAIKU   → triage classifier, context distiller, simple agent queries
//   REWRITER→ query rewriter (gpt-4o-mini or local Ollama — see query-rewriter.js)
//   EMBED   → OpenAI embeddings for Qdrant vector search (searchUtils.js)
//
// ── ENV OVERRIDES ─────────────────────────────────────────────────────────────
//
//   LLM_MODEL        overrides the Sonnet model string
//   TRIAGE_MODEL     overrides the Haiku model string
//
// ─────────────────────────────────────────────────────────────────────────────

// Claude Sonnet — used by specialist agents for deep reasoning + tool use
export const SONNET_MODEL = process.env.LLM_MODEL    || "claude-sonnet-4-6";

// Claude Haiku — used for triage, distillation, simple queries
export const HAIKU_MODEL  = process.env.TRIAGE_MODEL || "claude-haiku-4-5";

// Embedding model — OpenAI, used in searchUtils.js
export const EMBEDDING_MODEL    = "text-embedding-3-small";
export const EMBEDDING_PROVIDER = "openai";

// ── TOKEN BUDGETS ─────────────────────────────────────────────────────────────
//
// PHILOSOPHY: request only what each call actually needs.
//
//   Tool-call rounds   → Claude outputs only a JSON tool_use block (~50–150 tokens).
//                        Requesting 4096 here wastes capacity on every intermediate round.
//   Final agent answer → needs room for a full structured response.
//   Merge              → scales with agent count; capped dynamically in mergeAnswers().
//   Haiku calls        → triage + distillation never need more than 1024 tokens.

// Intermediate tool-call rounds — Claude only emits a tool_use JSON block here
export const MAX_TOKENS_TOOL_ROUND  = 1024;

// Final end_turn response from a specialist agent
export const MAX_TOKENS_AGENT_FINAL = 4096;

// Merger output — calculated dynamically per call, capped at this ceiling
export const MAX_TOKENS_MERGE_CAP   = 6144;

// Haiku calls — triage plan JSON, distilled summary, simple answers
export const MAX_TOKENS_HAIKU       = 1024;

// ── STEP LIMITS ───────────────────────────────────────────────────────────────
//
// Lower limits mean fewer tool-call rounds and faster, cheaper responses.
// Steps beyond these limits are almost always redundant refinement.

// Hard ceiling — never exceeded regardless of context
export const MAX_STEPS              = 12;

// Standalone agent (Mode 1, Mode 2) — enough for complex multi-table queries
export const MAX_STEPS_STANDALONE   = 8;

// Agent inside a sequential chain — context is pre-populated by distiller,
// so fewer rounds are needed to reach a complete answer
export const MAX_STEPS_SEQUENTIAL   = 8;

// ── CRAG THRESHOLDS ──────────────────────────────────────────────────────────
export const CRAG_HARD_THRESHOLD = 0.45;
export const CRAG_SOFT_THRESHOLD = 0.55;
export const CRAG_GOOD_THRESHOLD = 0.62;

// ── RETRIEVAL LIMITS ─────────────────────────────────────────────────────────
// Qdrant results are truncated to this count before the LLM sees them
export const QDRANT_MAX_CHUNKS   = 4;
// Chunks below this similarity score are dropped entirely
export const QDRANT_MIN_SCORE    = 0.40;

// ── CACHE ────────────────────────────────────────────────────────────────────
export const POSTGRES_CACHE_TTL_MS = 60 * 60 * 1000;  // 1 hour