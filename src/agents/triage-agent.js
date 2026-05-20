// src/agents/triage-agent.js
//
// Orchestrates all specialist agents.
//
// PIPELINE (every query goes through all three stages):
//
//   Stage 1 — Query Rewrite   (query-rewriter.js)
//     gpt-4o-mini or local Ollama
//     Expands terse queries, resolves block names, translates Hindi/Odia,
//     infers disaster context, outputs structured JSON.
//
//   Stage 2 — LLM Triage      (Claude Haiku)
//     Reads the rewritten query + inferred context.
//     Produces a structured routing plan: mode, agents, per-agent sub-queries,
//     dependency links, query complexity. No hardcoded keyword matching.
//
//   Stage 3 — Execution
//     Mode 1 — Single agent        : one specialist, direct answer
//     Mode 2 — Parallel (2 agents) : two INDEPENDENT domains, Promise.all, merge
//     Mode 3 — Sequential (2–3)    : dependent chain, Haiku distils context
//                                    between steps before injecting into next agent
//
// REMOVED:
//   Mode 3 — Sequential (2–3 steps) : dependent chain, Haiku distils context
//                                    between steps. Full briefs use Mode 2 parallel
//                                    (faster, no dependency penalty for block queries).
//
// TOKEN SAVINGS:
//   - Haiku for triage classification (not Sonnet)
//   - Haiku for context distillation between sequential steps
//   - query_complexity routing: simple → Haiku agent, complex → Sonnet agent
//   - Postgres cache + Qdrant truncation in tools.js (transparent to agents)

import Anthropic from "@anthropic-ai/sdk";
import { rewriteQuery }              from "./query-rewriter.js";
import { distilContext }             from "./context-distiller.js";
import { HAIKU_MODEL, SONNET_MODEL, MAX_TOKENS_MERGE_CAP, MAX_STEPS_SEQUENTIAL, MAX_TOKENS_HAIKU } from "./model-config.js";

import { disasterResponseAgent }   from "./disaster-response-agent.js";
import { reliefFinanceAgent }      from "./relief-finance-agent.js";
import { preparednessAgent }       from "./preparedness-agent.js";
import { resourceAllocationAgent } from "./resource-allocation-agent.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Agent Registry ────────────────────────────────────────────────────────────
// Single source of truth: agent name → { agent object, description, best_for }.
// Used to build the triage system prompt AND to resolve plan agent names → objects.

const AGENT_REGISTRY = {
  DisasterResponseAgent: {
    agent: disasterResponseAgent,
    description:
      "SOPs, department responsibilities, evacuation procedures, warning-level " +
      "actions, inter-agency coordination, historical cyclone/flood responses " +
      "(Phailin 2013, Fani 2019). Uses Qdrant for procedural prose + Postgres for contacts.",
    best_for: [
      "what should X department do", "evacuation procedure", "who is responsible",
      "SOP for", "cyclone response steps", "NDRF deployment",
      "historical event statistics", "red alert actions", "warning level",
    ],
  },
  ResourceAllocationAgent: {
    agent: resourceAllocationAgent,
    description:
      "Active resource deployment: rescue boats per block, medical team " +
      "availability, NGO mobilisation by block/specialisation, relief camp " +
      "setup, communication infrastructure gaps. Uses Postgres operational tables.",
    best_for: [
      "how many boats", "rescue resources", "deploy medical teams",
      "which NGOs", "plan for X block", "camp setup", "communication gap",
      "resource inventory", "boat reallocation",
    ],
  },
  ReliefFinanceAgent: {
    agent: reliefFinanceAgent,
    description:
      "Financial compensation: SDRF ex-gratia amounts, house damage rates, " +
      "crop loss compensation, Fani-specific relief packages, medical relief " +
      "norms. Uses Postgres SDRF tables primarily.",
    best_for: [
      "how much compensation", "ex-gratia", "SDRF norm",
      "rupees for house damage", "relief package amount",
      "financial assistance", "norm of assistance",
    ],
  },
  PreparednessAgent: {
    agent: preparednessAgent,
    description:
      "Pre-disaster preparedness: MCS shelter counts/locations, shelter " +
      "equipment inventory, early warning systems, VHF/telecom coverage, " +
      "training and mock drills, livestock shelters. " +
      "Uses Postgres shelter tables + Qdrant SDMP chapters.",
    best_for: [
      "how many shelters", "MCS equipment", "early warning",
      "shelter capacity", "training drill", "preparedness plan",
      "livestock shelter", "VHF station", "telecom coverage",
    ],
  },
};

// ── Triage System Prompt ──────────────────────────────────────────────────────
// Dynamically built from AGENT_REGISTRY so it stays in sync automatically.

const TRIAGE_SYSTEM_PROMPT = `You are the Triage Agent for an Odisha disaster management RAG platform.
Your ONLY job is to analyse an incoming query and produce a JSON routing plan.
You do NOT answer the query. You decide HOW it should be answered.

AVAILABLE SPECIALIST AGENTS:
${Object.entries(AGENT_REGISTRY)
  .map(
    ([name, info]) =>
      `\n${name}:\n  Handles: ${info.description}\n  Best for: ${info.best_for.join(", ")}`
  )
  .join("\n")}

EXECUTION MODES — choose exactly one:

MODE 1 — SINGLE AGENT
  Use when: query maps to exactly one agent's domain.
  Rule: DEFAULT to this. Most queries are Mode 1.
  Output: one step, sub_query = the specific focused question for that agent.

MODE 2 — PARALLEL (exactly 2 agents)
  Use when: query asks two INDEPENDENT questions from different domains.
  INDEPENDENCE TEST: Could Agent B answer its part without seeing Agent A's answer?
  If YES → parallel is fine.   If NO → use Mode 3 (sequential).
  Rule: maximum 2 agents. Never use for dependent questions.

  BLOCK RESOURCE PLAN RULE: "plan relief resources for X block / full resource plan for X block /
    shelters boats medical NGOs for X block" where X is a specific Puri district block name
    (Brahmagiri, Gop, Kanas, Puri Sadar, Nimapara, Kakatpur, Krushnaprasad, Astaranga,
    Delang, Satyabadi, Pipili) → Mode 2: ResourceAllocationAgent + DisasterResponseAgent.
    This rule ONLY applies when a specific Puri district block name is mentioned.
    Do NOT apply this rule for: district-wide queries, situational briefings, cyclone event
    queries (Fani/Dana/Phailin), or queries that don't name a specific block.

  Output: two steps, both with depends_on_step: null.

MODE 3 — SEQUENTIAL CHAIN (2 or 3 agents, max 3)
  Use when: Agent B's answer genuinely DEPENDS on seeing Agent A's output first.
  Context between steps is automatically compressed — Agent B receives a focused
  150-word summary, not the full prior answer. Max 3 steps.
  Output: each step after step 1 sets depends_on_step to the prior step number.

  HARD PROHIBITIONS — never use Mode 3 for:
  - Operator situational briefings ("generate a briefing", "operator briefing", "complete brief")
  - Cyclone event queries about Dana, Fani, or Phailin — these are SOP + history, Mode 1
  - Any query that names districts outside Puri (Bhadrak, Kendrapara, Balasore, Jagatsinghpur)
    because ResourceAllocationAgent only has Puri district block data
  - Queries with 5+ numbered sub-questions — these are Mode 1 with DisasterResponseAgent
    synthesising from Qdrant, not a multi-agent chain

SEQUENTIAL CHAIN PATTERNS — use Mode 3 ONLY when there is a genuine data dependency:
  SOP + Resources     → DisasterResponseAgent → ResourceAllocationAgent
    ONLY when: the resource query explicitly asks which specific Puri block to deploy to
    and that block choice depends on the SOP answer (rare)
  Resources + Finance → ResourceAllocationAgent → ReliefFinanceAgent
    ONLY when: compensation calculation requires knowing which specific households are affected

QUERY COMPLEXITY — always set this field:
  simple       = single factual lookup, one table or one document section
  compound     = multi-part question within one domain
  multi_domain = crosses two or more agent domains

CRITICAL RULES:
1. Operator briefings, cyclone event queries (Dana/Fani/Phailin), district-wide queries → Mode 1 ONLY.
2. Block resource plans (specific Puri block + shelters/boats/NGOs/medical) → Mode 2.
3. Mode 3 is rare — only genuine data dependencies warrant it. When in doubt, use Mode 1.
4. NEVER run the same agent twice in a Mode 3 chain (e.g. DisasterResponse → X → DisasterResponse).
   If you need historical context from DisasterResponseAgent, include it in sub_query for step 1.
5. Use EXACT agent names from the list above.
6. Each step's sub_query must be a FOCUSED question for that specific agent —
   not the full original query repeated verbatim.
7. reasoning must explain why this mode and these agents were chosen.

OUTPUT: respond ONLY with valid JSON. No markdown fences. No text outside the JSON.
{
  "mode": 1,  // 1 = single, 2 = parallel, 3 = sequential
  "query_complexity": "simple | compound | multi_domain",
  "execution_plan": [
    {
      "step": 1,
      "agent": "<ExactAgentName>",
      "sub_query": "<focused question for this agent>",
      "depends_on_step": null
    }
  ],
  "reasoning": "<why this mode and these agents>",
  "confidence": "high | medium | low"
}`;

// ── LLM Classifier ────────────────────────────────────────────────────────────

/**
 * Calls Claude Haiku to produce a structured routing plan.
 * Falls back to a safe Mode 1 (DisasterResponseAgent) plan on any failure.
 */
async function classifyWithLLM(rewrittenQuery, inferredContext) {
  const contextNote = inferredContext
    ? `\n\n[CONTEXT: disaster_type=${inferredContext.disaster_type}, ` +
      `event=${inferredContext.specific_event ?? "none"}, ` +
      `location=${inferredContext.location ?? "unspecified"}, ` +
      `complexity=${inferredContext.query_complexity}]`
    : "";

  try {
    const response = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 1024,
      system:     TRIAGE_SYSTEM_PROMPT,
      messages:   [{ role: "user", content: rewrittenQuery + contextNote }],
    });

    const text    = response.content.find((b) => b.type === "text")?.text ?? "";
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const plan    = JSON.parse(cleaned);

    validatePlan(plan, rewrittenQuery);

    console.log(
      `[triage] plan: mode=${plan.mode}  ` +
      `agents=${plan.execution_plan.map((s) => s.agent).join("→")}  ` +
      `complexity=${plan.query_complexity}`
    );
    console.log(`[triage] reasoning: ${plan.reasoning}`);

    return plan;

  } catch (err) {
    console.warn(`[triage] LLM classification failed (${err.message}) — Mode 1 fallback`);
    return buildFallbackPlan(rewrittenQuery);
  }
}

// Keywords that signal a situational briefing — should always be Mode 1
const BRIEFING_KEYWORDS = [
  "generate a complete", "operator briefing", "complete briefing",
  "complete operator", "generate a briefing", "full briefing",
];
// Districts outside Puri that ResourceAllocationAgent has no data for
const NON_PURI_DISTRICTS = [
  "kendrapara", "bhadrak", "balasore", "jagatsinghpur", "cuttack",
  "ganjam", "jajpur", "khurda", "nayagarh", "puri district",
];

function validatePlan(plan, originalQuery = "") {
  if (![1, 2, 3].includes(plan.mode)) {
    throw new Error(`invalid mode: ${plan.mode}`);
  }
  if (!Array.isArray(plan.execution_plan) || plan.execution_plan.length === 0) {
    throw new Error("execution_plan is empty");
  }
  for (const step of plan.execution_plan) {
    if (!AGENT_REGISTRY[step.agent]) {
      throw new Error(`unknown agent: "${step.agent}"`);
    }
    if (!step.sub_query?.trim()) {
      throw new Error(`step ${step.step} has empty sub_query`);
    }
  }
  if (plan.mode === 2 && plan.execution_plan.length !== 2) {
    throw new Error("Mode 2 must have exactly 2 agents");
  }
  if (plan.mode === 3 && (plan.execution_plan.length < 2 || plan.execution_plan.length > 3)) {
    throw new Error("Mode 3 must have 2 or 3 agents");
  }

  // ── Mode 3 safety checks ─────────────────────────────────────────────────
  if (plan.mode === 3) {
    const lower = originalQuery.toLowerCase();

    // Reject Mode 3 for operator/situational briefings → downgrade to Mode 1
    const isBriefing = BRIEFING_KEYWORDS.some((k) => lower.includes(k));
    if (isBriefing) {
      console.warn("[triage] validatePlan: Mode 3 rejected for operator briefing — downgrading to Mode 1");
      throw new Error("Mode 3 not permitted for operator briefings — use Mode 1");
    }

    // Reject Mode 3 for queries about non-Puri districts
    const hasNonPuriDistrict = NON_PURI_DISTRICTS.some((d) => lower.includes(d));
    if (hasNonPuriDistrict) {
      console.warn("[triage] validatePlan: Mode 3 rejected — query mentions non-Puri district → downgrading to Mode 1");
      throw new Error("Mode 3 not permitted for non-Puri district queries — use Mode 1");
    }

    // Reject Mode 3 if same agent appears more than once
    const agents = plan.execution_plan.map((s) => s.agent);
    const uniqueAgents = new Set(agents);
    if (uniqueAgents.size < agents.length) {
      console.warn("[triage] validatePlan: Mode 3 rejected — duplicate agent in chain → downgrading to Mode 1");
      throw new Error("Mode 3 chain cannot repeat the same agent");
    }
  }
}

// Puri district block names — used to detect block-specific resource queries
const PURI_BLOCKS = [
  "brahmagiri", "gop", "kanas", "puri sadar", "nimapara",
  "kakatpur", "krushnaprasad", "astaranga", "delang", "satyabadi", "pipili",
];

function buildFallbackPlan(query) {
  // Only route to Mode 2 for genuine block resource plan queries:
  // must name a specific Puri district block AND ask about resources.
  const lower = query.toLowerCase();
  const namedBlock = PURI_BLOCKS.find((b) => lower.includes(b));
  const isResourceQuery =
    lower.includes("shelters") || lower.includes("boats") ||
    lower.includes("ngo") || lower.includes("medical") || lower.includes("plan relief");

  if (namedBlock && isResourceQuery) {
    console.log(`[triage] fallback: block resource query (${namedBlock}) → Mode 2 parallel`);
    return {
      mode:             2,
      query_complexity: "multi_domain",
      execution_plan: [
        {
          step:            1,
          agent:           "ResourceAllocationAgent",
          sub_query:       query,
          depends_on_step: null,
        },
        {
          step:            2,
          agent:           "DisasterResponseAgent",
          sub_query:       `What are the response SOPs and NDRF/ODRAF deployment procedures for ${namedBlock} block?`,
          depends_on_step: null,
        },
      ],
      reasoning:  `fallback Mode 2 — LLM classification failed, block resource query detected (${namedBlock})`,
      confidence: "low",
    };
  }

  return {
    mode:             1,
    query_complexity: "simple",
    execution_plan: [{
      step:            1,
      agent:           "DisasterResponseAgent",
      sub_query:       query,
      depends_on_step: null,
    }],
    reasoning:  "fallback plan — LLM classification failed",
    confidence: "low",
  };
}

// ── Execution Engines ─────────────────────────────────────────────────────────

/** Mode 1 — single agent. Simple queries → Haiku; compound/multi-domain → Sonnet. */
async function executeSingle(step, queryComplexity) {
  const { agent } = AGENT_REGISTRY[step.agent];
  const modelTier = queryComplexity === "simple" ? "haiku" : "sonnet";
  console.log(`[triage] Mode 1 → ${step.agent}  model=${modelTier}`);
  return agent.run(step.sub_query, { modelTier });
}

/** Mode 2 — two independent agents run in parallel via Promise.all. */
async function executeParallel(steps) {
  console.log(`[triage] Mode 2 → parallel: ${steps.map((s) => s.agent).join(" + ")}`);
  const start = Date.now();

  const results = await Promise.all(
    steps.map((step) =>
      AGENT_REGISTRY[step.agent].agent.run(step.sub_query, { modelTier: "sonnet" })
    )
  );

  console.log(`[triage] parallel complete in ${Date.now() - start}ms`);
  return results;
}

/**
 * Mode 3 — sequential chain.
 * Each step receives a Haiku-distilled summary of the prior step's answer,
 * keeping injected context to ~150 tokens regardless of prior answer length.
 */
async function executeSequential(steps, originalQuery) {
  console.log(
    `[triage] Mode 3 → sequential (${steps.length} steps): ` +
    steps.map((s) => s.agent).join(" → ")
  );
  const results = [];

  for (const step of steps) {
    let enrichedQuery = step.sub_query;

    if (step.depends_on_step != null) {
      const priorIndex  = step.depends_on_step - 1;
      const priorResult = results[priorIndex];
      const priorAgent  = steps[priorIndex].agent;

      if (priorResult?.answer) {
        const distilled = await distilContext(
          priorResult.answer,
          priorAgent,
          step.agent,
          originalQuery
        );

        enrichedQuery =
          `${step.sub_query}\n\n` +
          `[CONTEXT FROM ${priorAgent} — use to inform your answer]:\n` +
          `${distilled.summary}`;

        console.log(
          `[triage] step ${step.step}: distilled context ` +
          `${distilled.original_length} → ${distilled.summary_length} chars ` +
          `(${Math.round((1 - distilled.summary_length / distilled.original_length) * 100)}% saved)`
        );
      }
    }

    const start = Date.now();
    console.log(`[triage] step ${step.step}: running ${step.agent}...`);
    const result = await AGENT_REGISTRY[step.agent].agent.run(enrichedQuery, { modelTier: "sonnet", maxSteps: MAX_STEPS_SEQUENTIAL });
    console.log(`[triage] step ${step.step}: done in ${Date.now() - start}ms  steps=${result.steps}`);

    results.push(result);
  }

  return results;
}

// ── Response Merger ───────────────────────────────────────────────────────────

/**
 * Merges multiple agent answers into one unified operational briefing.
 * Only called when 2+ agents ran (Mode 2 or Mode 3).
 * Uses Sonnet — this is a synthesis task that requires coherent prose.
 */
async function mergeAnswers(originalQuery, agentResults, plan) {
  const agentNames = agentResults.map((r, i) => r.agentName ?? plan.execution_plan[i].agent);

  const sections = agentResults
    .map((r, i) => `## ${agentNames[i]}\n\n${r.answer}`)
    .join("\n\n---\n\n");

  // Token-efficient merge prompt — routing reasoning omitted (not needed for synthesis)
  const mergePrompt =
    `You are synthesising answers from multiple specialist disaster management agents.\n\n` +
    `ORIGINAL QUERY:\n${originalQuery}\n\n` +
    `SPECIALIST RESPONSES:\n${sections}\n\n` +
    `MERGE INSTRUCTIONS:\n` +
    `- Combine into ONE unified operational briefing.\n` +
    `- Remove duplication — if two agents said the same thing, say it once.\n` +
    `- Preserve ALL figures, section references, block names, rupee amounts, resource counts.\n` +
    `- For sequential results: later agents build on earlier ones — reflect this narrative.\n` +
    `- Use numbered sections. Lead with the most operationally urgent information.\n` +
    `- End with: CONFIDENCE: HIGH|MEDIUM|LOW (agents=${agentNames.join("+")})`;

  // Scale output budget to agent count — 2 agents need ~2500 tokens, 3 agents ~5000.
  // Cap at MAX_TOKENS_MERGE_CAP to prevent runaway costs.
  const mergeTokens = Math.min(agentResults.length * 2048, MAX_TOKENS_MERGE_CAP);

  const response = await client.messages.create({
    model:      SONNET_MODEL,
    max_tokens: mergeTokens,
    messages:   [{ role: "user", content: mergePrompt }],
  });

  // Fallback: raw concatenation if Sonnet call fails
  return response.content.find((b) => b.type === "text")?.text ?? sections;
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

/**
 * Full pipeline: rewrite → classify → execute → (distil between steps) → (merge)
 *
 * @param {string} rawMessage - The original user query
 * @returns {Promise<TriageResult>}
 */
export async function runTriage(rawMessage) {

  // ── Stage 1: Query Rewrite ────────────────────────────────────────────────
  console.log("[triage] stage 1: rewriting query...");
  const rewriteResult = await rewriteQuery(rawMessage);
  const { rewritten_query, inferred_context, was_rewritten } = rewriteResult;

  if (was_rewritten) {
    console.log(`[triage] rewritten: "${rawMessage}" → "${rewritten_query}"`);
  } else {
    console.log("[triage] no rewrite (passthrough or already detailed)");
  }

  // ── Stage 2: LLM Routing Classification ──────────────────────────────────
  console.log("[triage] stage 2: classifying with Haiku...");
  const plan = await classifyWithLLM(rewritten_query, inferred_context);

  // ── Stage 3: Execute ──────────────────────────────────────────────────────
  console.log(`[triage] stage 3: executing mode=${plan.mode}...`);

  if (plan.mode === 1) {
    const result = await executeSingle(plan.execution_plan[0], plan.query_complexity);
    return {
      answer:    result.answer,
      agentName: plan.execution_plan[0].agent,
      steps:     result.steps ?? 0,
      mode:      1,
      plan,
      rewrite:   rewriteResult,
    };
  }

  if (plan.mode === 2) {
    const results      = await executeParallel(plan.execution_plan);
    const mergedAnswer = await mergeAnswers(rawMessage, results, plan);
    return {
      answer:    mergedAnswer,
      agentName: results.map((r) => r.agentName).join("+"),
      steps:     results.reduce((s, r) => s + (r.steps ?? 0), 0),
      mode:      2,
      plan,
      rewrite:   rewriteResult,
    };
  }

  if (plan.mode === 3) {
    const results      = await executeSequential(plan.execution_plan, rawMessage);
    const mergedAnswer = await mergeAnswers(rawMessage, results, plan);
    return {
      answer:    mergedAnswer,
      agentName: results.map((r) => r.agentName).join("→"),
      steps:     results.reduce((s, r) => s + (r.steps ?? 0), 0),
      mode:      3,
      plan,
      rewrite:   rewriteResult,
    };
  }

  // Should never reach here after validatePlan — safety net
  throw new Error(`[triage] unhandled mode: ${plan.mode}`);
}

/**
 * @typedef {Object} TriageResult
 * @property {string} answer    - Final merged or single-agent answer
 * @property {string} agentName - "AgentA" | "AgentA+AgentB" | "AgentA→AgentB→AgentC"
 * @property {number} steps     - Total tool-call rounds across all agents
 * @property {number} mode      - Execution mode used: 1 | 2 | 3
 * @property {object} plan      - Full routing plan from the Haiku triage LLM
 * @property {object} rewrite   - Query rewrite result from Stage 1
 */