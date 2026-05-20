// src/agents/context-distiller.js
//
// Compresses one agent's full answer into a focused summary
// before passing it to the next agent in a sequential chain.
//
// WHY THIS EXISTS:
//   In a sequential chain, Agent B receives Agent A's full answer as context.
//   A full Sonnet answer can be 800–1,500 tokens. In a 3-step chain, Agent 3
//   would receive ~3,000 tokens of prior context before its own input even starts.
//   This function uses Haiku to distil that down to ~150 tokens of targeted facts.
//
// TOKEN SAVINGS: ~60–70% reduction on step 2 and step 3 input context.
//
// MODEL: Claude Haiku — this is a compression task, not reasoning.
//   Using Haiku here costs ~10x less than Sonnet and completes in ~500ms.

import Anthropic from "@anthropic-ai/sdk";
import { HAIKU_MODEL } from "./model-config.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Agent-to-Agent Handoff Templates ─────────────────────────────────────────
// Each key defines exactly which facts matter when handing off FROM one agent TO another.
// Direction-specific templates prevent the distiller from summarising irrelevant content.
// If no template exists for a pair, DEFAULT_FOCUS is used.

const HANDOFF_FOCUS = {

  // DisasterResponse → ResourceAllocation
  // SOP context feeds into resource deployment planning
  "DisasterResponseAgent→ResourceAllocationAgent":
    "Extract only: (1) specific departments and their assigned responsibilities, " +
    "(2) resource types explicitly mentioned (boats, personnel, shelters, NGOs, teams), " +
    "(3) block or district names where action is needed, " +
    "(4) any identified gaps or shortfalls in response capacity. " +
    "Omit: general cyclone background, full SOP text, confidence scores.",

  // ResourceAllocation → ReliefFinance
  // Affected population and resource gaps feed into compensation calculation
  "ResourceAllocationAgent→ReliefFinanceAgent":
    "Extract only: (1) block names and estimated affected population counts, " +
    "(2) specific resource shortfalls (e.g. 'Brahmagiri has only 1 boat'), " +
    "(3) number of families or households affected, " +
    "(4) infrastructure damage categories if mentioned (pucca/kutcha houses, crops). " +
    "Omit: boat IDs, NGO lists, telecom details, confidence scores.",

  // Preparedness → DisasterResponse
  // Shelter gaps and infrastructure status feed into SOP selection
  "PreparednessAgent→DisasterResponseAgent":
    "Extract only: (1) total shelter count and any capacity shortfall figures, " +
    "(2) specific gaps — blocks with insufficient shelters or missing equipment, " +
    "(3) communication dead zones (VHF not installed, coverage gaps by block), " +
    "(4) early warning system deficiencies. " +
    "Omit: individual shelter names, GP details, funding agencies, confidence scores.",

  // Preparedness → ResourceAllocation
  // Infrastructure gaps feed directly into resource deployment planning
  "PreparednessAgent→ResourceAllocationAgent":
    "Extract only: (1) blocks with shelter shortfalls and estimated overflow population, " +
    "(2) specific missing equipment items and quantities, " +
    "(3) communication infrastructure gaps by block name. " +
    "Omit: individual shelter names, GP details, funding agencies, confidence scores.",

  // DisasterResponse → ReliefFinance
  // Event impact data feeds into compensation amount calculation
  "DisasterResponseAgent→ReliefFinanceAgent":
    "Extract only: (1) number of casualties or deaths reported, " +
    "(2) number of damaged houses and type (pucca/kutcha/severely damaged), " +
    "(3) crop loss area in hectares if mentioned, " +
    "(4) names of affected blocks or districts. " +
    "Omit: evacuation procedures, department SOPs, agency responsibilities, confidence scores.",
};

// Default — used when no specific handoff template exists for the agent pair
const DEFAULT_FOCUS =
  "Extract only the key factual findings: numbers, block names, resource counts, " +
  "identified gaps, and specific action items. Omit background context, procedures, " +
  "and confidence scores. Maximum 150 words.";

// ── Main Export ───────────────────────────────────────────────────────────────

/**
 * Distils an agent's full answer into a focused summary for the next agent in a chain.
 *
 * @param {string} answer        - Full answer from the previous agent
 * @param {string} fromAgent     - Name of the agent that produced the answer
 * @param {string} toAgent       - Name of the next agent that will receive the summary
 * @param {string} originalQuery - The original user query (for distillation context)
 * @returns {Promise<DistilledContext>}
 */
export async function distilContext(answer, fromAgent, toAgent, originalQuery) {
  // Skip distillation for short answers — nothing meaningful to compress
  if (!answer || answer.trim().length < 300) {
    console.log(`[distiller] skip (answer too short: ${answer?.length ?? 0} chars)`);
    return {
      summary:         answer ?? "",
      original_length: answer?.length ?? 0,
      summary_length:  answer?.length ?? 0,
      was_distilled:   false,
      handoff_key:     `${fromAgent}→${toAgent}`,
    };
  }

  const handoffKey = `${fromAgent}→${toAgent}`;
  const focusInstr = HANDOFF_FOCUS[handoffKey] ?? DEFAULT_FOCUS;

  const prompt =
    `You are compressing an agent's answer for handoff to the next agent in a pipeline.\n\n` +
    `ORIGINAL USER QUERY: ${originalQuery}\n\n` +
    `ANSWER FROM ${fromAgent}:\n${answer}\n\n` +
    `COMPRESSION INSTRUCTION:\n${focusInstr}\n\n` +
    `Write a compressed summary in plain prose. No headers. No bullet points. ` +
    `Maximum 150 words. Include only what ${toAgent} needs to do its job.`;

  try {
    const response = await client.messages.create({
      model:      HAIKU_MODEL,
      max_tokens: 300,   // hard cap — distilled context must stay short
      messages:   [{ role: "user", content: prompt }],
    });

    const summary = response.content.find((b) => b.type === "text")?.text?.trim() ?? answer;

    const reduction = Math.round((1 - summary.length / answer.length) * 100);
    console.log(
      `[distiller] ${handoffKey}: ${answer.length} → ${summary.length} chars (${reduction}% reduction)`
    );

    return {
      summary,
      original_length: answer.length,
      summary_length:  summary.length,
      was_distilled:   true,
      handoff_key:     handoffKey,
    };

  } catch (err) {
    console.warn(`[distiller] distillation failed (${err.message}), using original answer`);
    return {
      summary:         answer,
      original_length: answer.length,
      summary_length:  answer.length,
      was_distilled:   false,
      handoff_key:     handoffKey,
    };
  }
}

/**
 * @typedef {Object} DistilledContext
 * @property {string}  summary          - Compressed summary (or original if skipped/failed)
 * @property {number}  original_length  - Character count of the full original answer
 * @property {number}  summary_length   - Character count of the distilled summary
 * @property {boolean} was_distilled    - false if passthrough (too short or error)
 * @property {string}  handoff_key      - "FromAgent→ToAgent" pair identifier
 */