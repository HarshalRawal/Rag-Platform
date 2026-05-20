// src/agents/query-rewriter.js
//
// Stage 1: Query Rewriter
//
// Rewrites raw user queries into clean, domain-enriched versions before
// they reach the triage LLM. Handles terse inputs, mixed-language phrases,
// abbreviations, and ambiguous location references.
//
// ── PROVIDER SELECTION ────────────────────────────────────────────────────────
//
//   Set REWRITER_PROVIDER in your .env to choose the backend:
//
//   REWRITER_PROVIDER=openai      → gpt-4o-mini  (default)
//                                   requires: OPENAI_API_KEY
//                                   latency:  ~400ms
//                                   cost:     ~$0.0002/query
//
//   REWRITER_PROVIDER=ollama      → local Ollama model
//                                   requires: Ollama running locally or on LAN
//                                   latency:  ~800ms–2s (depends on GPU/CPU)
//                                   cost:     free
//
// ── OLLAMA CONFIGURATION ──────────────────────────────────────────────────────
//
//   OLLAMA_HOST=http://localhost:11434   (default)
//   OLLAMA_MODEL=mistral:7b              (default)
//
//   Recommended models for this task (JSON output reliability ranked):
//     mistral:7b          — best JSON reliability, good domain understanding
//     llama3.2:3b         — fastest, slightly weaker JSON adherence
//     llama3.1:8b         — good balance, needs ~8GB VRAM
//     phi3:mini           — very fast on CPU, acceptable quality
//     gemma2:2b           — good for low-memory machines
//
//   Pull a model:   ollama pull mistral:7b
//   Verify running: curl http://localhost:11434/api/tags
//
// ── ENV VARIABLES SUMMARY ────────────────────────────────────────────────────
//
//   REWRITER_PROVIDER          = "openai" | "ollama"     (default: openai)
//   OPENAI_API_KEY             = sk-...                  (required for openai)
//   REWRITER_OPENAI_MODEL      = "gpt-4o-mini"           (default)
//   OLLAMA_HOST                = "http://localhost:11434" (default)
//   OLLAMA_MODEL               = "mistral:7b"            (default)
//
// ── SKIPPING REWRITE ─────────────────────────────────────────────────────────
//
//   Queries longer than 100 chars that already contain domain terms are passed
//   through without calling the rewriter model — saving latency and cost.
//
// ── RUNTIME OVERRIDE ─────────────────────────────────────────────────────────
//
//   Override the provider per-call without changing the env:
//     rewriteQuery(query, { provider: "ollama" })
//     rewriteQuery(query, { provider: "openai" })
//
// ─────────────────────────────────────────────────────────────────────────────

// ── Environment config ────────────────────────────────────────────────────────

const REWRITER_PROVIDER = (process.env.REWRITER_PROVIDER || "openai").toLowerCase();
const OLLAMA_HOST       = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_MODEL      = process.env.OLLAMA_MODEL || "mistral:7b";
const OPENAI_MODEL      = process.env.REWRITER_OPENAI_MODEL || "gpt-4o-mini";

// Lazy OpenAI client — only created when the openai provider is actually used.
// Prevents a crash at module load time when OPENAI_API_KEY is absent and you
// are running the ollama provider.
let _openaiClient = null;

// ── System Prompt ─────────────────────────────────────────────────────────────
// Shared between both providers. Kept focused — a tight prompt improves JSON
// adherence from smaller Ollama models and reduces latency on both providers.

const REWRITER_SYSTEM_PROMPT = `You are a query rewriter for a disaster management decision-support platform
covering Odisha, India — specifically Puri district and the Odisha State Disaster Management Plan (SDMP).

Your job is to take a raw user query (which may be terse, ambiguous, partly in Hindi/Odia, or poorly
spelled) and rewrite it into a clear, complete, domain-rich English query that will be understood by
specialist disaster management agents.

DOMAIN KNOWLEDGE (use this to enrich queries):
- Platform covers: Cyclone Fani (2019), Cyclone Phailin (2013), Puri DDMP, Odisha SDMP 2019
- Puri district blocks: Brahmagiri, Puri Sadar, Gop, Kakatpur, Nimapara, Krushnaprasad,
  Astaranga, Kanas, Delang, Satyabadi, Pipili
- SDRF  = State Disaster Response Fund (compensation norms for disaster victims)
- MCS   = Multi-Purpose Cyclone Shelter (permanent, elevated, govt-built)
- ODRAF = Odisha Disaster Rapid Action Force
- DDMP  = District Disaster Management Plan
- SDMP  = State Disaster Management Plan

REWRITING RULES:
1. Expand abbreviations inline: "MCS" → "Multi-Purpose Cyclone Shelter (MCS)"
2. Resolve bare block names: "brahmagiri" → "Brahmagiri block, Puri district, Odisha"
3. Infer disaster type from context if not stated (most queries relate to cyclone or flood)
4. Translate Hindi/Odia fragments:
   "kaha hai" → "where are", "kitne" → "how many", "kab" → "when",
   "kaun" → "who", "kya" → "what", "kaise" → "how"
5. Preserve all specific numbers, names, rupee amounts, and dates exactly
6. Do NOT add information that was not implied or stated in the original
7. Keep the rewritten query as a single natural English question

QUERY COMPLEXITY DEFINITIONS:
- simple       = one factual lookup (one table or one document section)
- compound     = multi-part question within a single domain
- multi_domain = crosses two or more agent domains (SOPs + resources, finance + preparedness)

OUTPUT FORMAT: respond ONLY with a valid JSON object.
No markdown fences. No explanation before or after. Just the JSON object.
{
  "rewritten_query": "<full clear English question>",
  "original_query":  "<verbatim original — copy exactly, do not modify>",
  "inferred_context": {
    "disaster_type":    "cyclone | flood | earthquake | general | unknown",
    "specific_event":   "fani_2019 | phailin_2013 | null",
    "location":         "<block and/or district string, or null>",
    "time_reference":   "<ISO date string if a cutoff date is mentioned, else null>",
    "user_type":        "operator | citizen | unknown",
    "query_complexity": "simple | compound | multi_domain"
  },
  "rewrite_notes": "<one sentence: what changed and why, or 'no changes needed'>"
}`;

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Rewrites a raw user query into a structured, domain-enriched version.
 *
 * @param {string} rawQuery        - Raw input from the user
 * @param {object} [opts]          - Optional per-call overrides
 * @param {string} [opts.provider] - "openai" | "ollama" — overrides REWRITER_PROVIDER env var
 * @returns {Promise<RewriteResult>}
 */
export async function rewriteQuery(rawQuery, opts = {}) {
  if (!rawQuery || rawQuery.trim().length === 0) {
    throw new Error("[query-rewriter] empty query");
  }

  // Passthrough: skip the model call for already-detailed queries
  if (shouldSkipRewrite(rawQuery)) {
    console.log("[query-rewriter] skip — query already detailed, using passthrough");
    return buildPassthroughResult(rawQuery, "passthrough — query already detailed");
  }

  // Resolve provider: per-call override wins, then env var, then default
  const provider = (opts.provider || REWRITER_PROVIDER).toLowerCase();

  if (provider !== "openai" && provider !== "ollama") {
    console.warn(`[query-rewriter] unknown provider "${provider}", falling back to openai`);
  }

  const useOllama = provider === "ollama";
  console.log(
    `[query-rewriter] provider=${provider} ` +
    `model=${useOllama ? OLLAMA_MODEL : OPENAI_MODEL}`
  );

  try {
    const rawResponse = useOllama
      ? await callOllama(rawQuery)
      : await callOpenAI(rawQuery);

    return parseRewriteResult(rawResponse, rawQuery, provider);

  } catch (err) {
    console.warn(`[query-rewriter] rewrite failed (${err.message}) — using passthrough`);
    return buildPassthroughResult(rawQuery, `rewrite failed: ${err.message}`);
  }
}

// ── Provider: OpenAI ──────────────────────────────────────────────────────────

async function callOpenAI(query) {
  // Dynamic import — the openai package is optional when using Ollama provider.
  // This import only runs when openai is actually needed, so Ollama-only users
  // don't need to install the openai npm package.
  const { default: OpenAI } = await import("openai");

  if (!_openaiClient) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not set. " +
        "Either add it to your .env or switch to REWRITER_PROVIDER=ollama"
      );
    }
    _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  const response = await _openaiClient.chat.completions.create({
    model:       OPENAI_MODEL,
    temperature: 0.1,    // low temperature — deterministic, consistent rewrites
    max_tokens:  512,
    // response_format forces JSON output — prevents markdown wrapping on gpt-4o-mini
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: REWRITER_SYSTEM_PROMPT },
      { role: "user",   content: query },
    ],
  });

  return response.choices[0]?.message?.content ?? "";
}

// ── Provider: Ollama ──────────────────────────────────────────────────────────

async function callOllama(query) {
  const url = `${OLLAMA_HOST}/api/chat`;

  let response;
  try {
    response = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      // 30s timeout — generous to handle cold model load on first request.
      // Subsequent requests to the same model are much faster (~800ms).
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model:  OLLAMA_MODEL,
        stream: false,
        // format: "json" instructs Ollama to enforce JSON output mode.
        // Supported in Ollama >=0.1.14 with compatible models (mistral, llama3, etc.)
        // Falls back gracefully — if the model ignores it, parseRewriteResult handles it.
        format: "json",
        options: {
          temperature: 0.1,
          num_predict: 512,
        },
        messages: [
          { role: "system", content: REWRITER_SYSTEM_PROMPT },
          { role: "user",   content: query },
        ],
      }),
    });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(
        `Ollama timed out after 30s. ` +
        `Is the model loaded? Try running: ollama run ${OLLAMA_MODEL}`
      );
    }
    throw new Error(`Cannot reach Ollama at ${url}: ${err.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const hint = body.includes("model") && body.includes("not found")
      ? ` — run: ollama pull ${OLLAMA_MODEL}`
      : "";
    throw new Error(`Ollama HTTP ${response.status}${hint}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  // Ollama /api/chat response: { message: { role: "assistant", content: "..." }, done: true }
  const content = data.message?.content ?? "";
  if (!content) {
    throw new Error("Ollama returned empty content in message.content");
  }

  return content;
}

// ── Health Check ──────────────────────────────────────────────────────────────

/**
 * Checks whether Ollama is reachable and the configured model is available.
 * Call this at server startup to surface missing-model errors early.
 *
 * @returns {Promise<OllamaHealthResult>}
 *
 * @example
 * const health = await checkOllamaHealth();
 * if (!health.ok) console.error(health.error);
 */
export async function checkOllamaHealth() {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      return { ok: false, error: `Ollama returned HTTP ${response.status}` };
    }

    const data   = await response.json();
    const models = (data.models ?? []).map((m) => m.name);

    // Match on the model base name (before the colon) to handle tag variants
    // e.g. "mistral:7b" should match "mistral:7b-instruct-q4_0"
    const baseName = OLLAMA_MODEL.split(":")[0];
    const hasModel = models.some((m) => m.startsWith(baseName));

    if (!hasModel) {
      return {
        ok:     false,
        models,
        error:
          `Model "${OLLAMA_MODEL}" not found in Ollama. ` +
          `Available: [${models.join(", ")}]. ` +
          `Run: ollama pull ${OLLAMA_MODEL}`,
      };
    }

    return {
      ok:     true,
      model:  OLLAMA_MODEL,
      host:   OLLAMA_HOST,
      models,
    };

  } catch (err) {
    if (err.name === "TimeoutError") {
      return {
        ok:    false,
        error: `Ollama not responding at ${OLLAMA_HOST} (timeout 3s). Is it running?`,
      };
    }
    return {
      ok:    false,
      error: `Cannot reach Ollama at ${OLLAMA_HOST}: ${err.message}`,
    };
  }
}

// ── Startup Logger ────────────────────────────────────────────────────────────

/**
 * Logs the active rewriter configuration at server startup.
 * Call once in your server entry point (e.g. server.js or index.js).
 *
 * @example
 * // In server.js:
 * import { logRewriterConfig } from "./agents/query-rewriter.js";
 * await logRewriterConfig();
 */
export async function logRewriterConfig() {
  const provider = REWRITER_PROVIDER;

  if (provider === "ollama") {
    const health = await checkOllamaHealth();
    if (health.ok) {
      console.log(
        `[query-rewriter] ✓ provider=ollama  ` +
        `host=${OLLAMA_HOST}  model=${OLLAMA_MODEL}`
      );
    } else {
      console.error(`[query-rewriter] ✗ provider=ollama — ${health.error}`);
      console.error(
        "[query-rewriter]   Rewriter will fall back to passthrough (no rewriting) on every call."
      );
    }
  } else {
    const hasKey = !!process.env.OPENAI_API_KEY;
    console.log(
      `[query-rewriter] ${hasKey ? "✓" : "✗"} provider=openai  ` +
      `model=${OPENAI_MODEL}  ` +
      `key=${hasKey ? "set" : "MISSING"}`
    );
    if (!hasKey) {
      console.error(
        "[query-rewriter]   OPENAI_API_KEY not set. " +
        "Set it in .env or switch to REWRITER_PROVIDER=ollama"
      );
    }
  }
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the query is already detailed enough that the rewriter
 * adds little value. Saves a model call and ~400ms of latency.
 */
function shouldSkipRewrite(query) {
  // Strip injected context tags ([CALLER ROLE:...], [EVALUATION MODE:...])
  // before measuring length — these tags are added by query.js and inflate
  // the character count, causing short terse queries to be skipped incorrectly.
  const stripped = query.replace(/\[.*?\]/gs, "").trim();
  const lower    = stripped.toLowerCase();

  // Always rewrite very short queries — most likely to need expansion
  if (lower.length < 20) return false;

  // Only skip if the query is genuinely long AND already contains domain vocabulary.
  // Threshold raised to 120 chars (was 100) to be more aggressive about rewriting.
  const isLong = lower.length > 120;
  const hasDomainTerms = [
    "sdrf", "ddmp", "sdmp", "mcs", "cyclone fani", "cyclone phailin",
    "puri district", "odisha", "ex-gratia", "evacuation procedure",
    "rescue boats", "relief package", "block, puri",
  ].some((term) => lower.includes(term));

  return isLong && hasDomainTerms;
}

function buildPassthroughResult(rawQuery, reason) {
  return {
    rewritten_query:  rawQuery,
    original_query:   rawQuery,
    inferred_context: {
      disaster_type:    "unknown",
      specific_event:   null,
      location:         null,
      time_reference:   null,
      user_type:        "unknown",
      query_complexity: "simple",
    },
    rewrite_notes: reason,
    was_rewritten: false,
    provider:      "none",
  };
}

function parseRewriteResult(rawText, originalQuery, provider) {
  // Strip markdown fences — some models wrap JSON in ```json...``` even when
  // told not to. The OpenAI response_format: json_object prevents this for
  // gpt-4o-mini, but Ollama models vary. Strip defensively.
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned);

    // Validate the most important field exists
    if (!parsed.rewritten_query || typeof parsed.rewritten_query !== "string") {
      throw new Error("rewritten_query field missing or not a string");
    }

    // Ensure inferred_context exists with defaults for any missing fields
    const ctx = parsed.inferred_context ?? {};
    const safeCtx = {
      disaster_type:    ctx.disaster_type    ?? "unknown",
      specific_event:   ctx.specific_event   ?? null,
      location:         ctx.location         ?? null,
      time_reference:   ctx.time_reference   ?? null,
      user_type:        ctx.user_type        ?? "unknown",
      query_complexity: ctx.query_complexity ?? "simple",
    };

    return {
      rewritten_query:  parsed.rewritten_query.trim(),
      original_query:   originalQuery,                 // always verbatim original
      inferred_context: safeCtx,
      rewrite_notes:    parsed.rewrite_notes ?? "",
      was_rewritten:    parsed.rewritten_query.trim() !== originalQuery.trim(),
      provider,
    };

  } catch (err) {
    console.warn(`[query-rewriter] JSON parse failed: ${err.message}`);
    console.warn(`[query-rewriter] raw response (first 400 chars): ${rawText.slice(0, 400)}`);
    return buildPassthroughResult(originalQuery, `JSON parse failed: ${err.message}`);
  }
}

// ── JSDoc Types ───────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RewriteResult
 * @property {string}          rewritten_query  - Cleaned, expanded query for triage
 * @property {string}          original_query   - Verbatim original input (never modified)
 * @property {InferredContext} inferred_context - Structured metadata extracted from query
 * @property {string}          rewrite_notes    - One-sentence explanation of what changed
 * @property {boolean}         was_rewritten    - false if passthrough or no changes
 * @property {string}          provider         - "openai" | "ollama" | "none"
 *
 * @typedef {Object} InferredContext
 * @property {string}      disaster_type    - "cyclone"|"flood"|"earthquake"|"general"|"unknown"
 * @property {string|null} specific_event   - "fani_2019"|"phailin_2013"|null
 * @property {string|null} location         - Block/district string or null
 * @property {string|null} time_reference   - ISO date if mentioned, else null
 * @property {string}      user_type        - "operator"|"citizen"|"unknown"
 * @property {string}      query_complexity - "simple"|"compound"|"multi_domain"
 *
 * @typedef {Object} OllamaHealthResult
 * @property {boolean}   ok      - true if Ollama is reachable and model is available
 * @property {string}    [error] - Error description if ok is false
 * @property {string[]}  [models]- All available model names (when reachable)
 * @property {string}    [model] - Configured model name (when ok)
 * @property {string}    [host]  - Ollama host URL (when ok)
 */