// src/agents/agent-runner.js
//
// Pure Anthropic SDK agent runner.
//
// BUG FIXES:
//   1. Adaptive token budget: tracks accumulated tool result size. Once it exceeds
//      LARGE_CONTEXT_THRESHOLD (8000 chars), all subsequent rounds use finalTokens
//      instead of MAX_TOKENS_TOOL_ROUND. Prevents the max_tokens→retry→max_tokens
//      loop that killed Q1 (Brahmagiri compound plan, 273 rows of tool results).
//   2. max_tokens retry now sets accumulatedToolResultChars above threshold so all
//      future rounds in that call also use the full budget — not just the retry round.
//   3. "Still max_tokens after retry" returns a graceful error instead of crashing.

import Anthropic from "@anthropic-ai/sdk";
import {
  SONNET_MODEL,
  HAIKU_MODEL,
  MAX_TOKENS_TOOL_ROUND,
  MAX_TOKENS_AGENT_FINAL,
  MAX_TOKENS_HAIKU,
  MAX_STEPS_STANDALONE,
} from "./model-config.js";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Switch to full token budget once accumulated tool results exceed this size.
const LARGE_CONTEXT_THRESHOLD = 8000;

export function createAgent(name, system, toolDefs = {}) {
  const anthropicTools = Object.entries(toolDefs).map(([toolName, def]) => ({
    name:         toolName,
    description:  def.description,
    input_schema: def.input_schema,
  }));

  return {
    name,

    async run(userMessage, opts = {}) {
      const modelTier   = (opts.modelTier || "sonnet").toLowerCase();
      const isHaiku     = modelTier === "haiku";
      const model       = isHaiku ? HAIKU_MODEL : SONNET_MODEL;
      const maxSteps    = opts.maxSteps ?? (isHaiku ? 4 : MAX_STEPS_STANDALONE);
      const finalTokens = isHaiku ? MAX_TOKENS_HAIKU : MAX_TOKENS_AGENT_FINAL;

      console.log(`[${name}] starting  model=${model}  maxSteps=${maxSteps}`);

      const messages = [{ role: "user", content: userMessage }];
      let steps = 0;
      let accumulatedToolResultChars = 0; // tracks context growth

      while (steps < maxSteps) {
        steps++;

        // Adaptive budget: cheap for small contexts, full for large ones
        const tokenBudget =
          accumulatedToolResultChars > LARGE_CONTEXT_THRESHOLD
            ? finalTokens
            : MAX_TOKENS_TOOL_ROUND;

        const response = await client.messages.create({
          model,
          max_tokens: tokenBudget,
          system,
          tools:      anthropicTools,
          messages,
        });

        messages.push({ role: "assistant", content: response.content });

        // ── FINAL ANSWER ────────────────────────────────────────────────────
        if (response.stop_reason === "end_turn") {
          const textBlock = response.content.find((b) => b.type === "text");
          const answer    = textBlock?.text ?? "";

          // Short answer on small budget — upgrade and retry
          if (answer.length < 200 && tokenBudget === MAX_TOKENS_TOOL_ROUND && steps > 1) {
            console.log(`[${name}] answer short (${answer.length} chars), upgrading to full budget`);
            messages.pop();
            const fullResponse = await client.messages.create({
              model, max_tokens: finalTokens, system, tools: anthropicTools, messages,
            });
            const fullText = fullResponse.content.find((b) => b.type === "text");
            console.log(`[${name}] done  steps=${steps}  model=${model}`);
            return { answer: fullText?.text ?? answer, agentName: name, steps, model };
          }

          console.log(`[${name}] done  steps=${steps}  model=${model}`);
          return { answer, agentName: name, steps, model };
        }

        // ── TOOL USE ────────────────────────────────────────────────────────
        if (response.stop_reason === "tool_use") {
          const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");

          const toolResults = await Promise.all(
            toolUseBlocks.map(async (block) => {
              const toolDef = toolDefs[block.name];
              if (!toolDef) return {
                type: "tool_result", tool_use_id: block.id,
                content: `Error: unknown tool "${block.name}"`, is_error: true,
              };
              try {
                console.log(`[${name}] tool=${block.name}`, JSON.stringify(block.input).slice(0, 120));
                const result  = await toolDef.execute(block.input);
                const content = JSON.stringify(result);
                accumulatedToolResultChars += content.length;
                return { type: "tool_result", tool_use_id: block.id, content };
              } catch (err) {
                console.error(`[${name}] tool error  tool=${block.name}:`, err.message);
                return {
                  type: "tool_result", tool_use_id: block.id,
                  content: `Error executing ${block.name}: ${err.message}`, is_error: true,
                };
              }
            })
          );

          if (accumulatedToolResultChars > LARGE_CONTEXT_THRESHOLD) {
            console.log(
              `[${name}] large context (${accumulatedToolResultChars} chars) ` +
              `— using full token budget for remaining rounds`
            );
          }

          messages.push({ role: "user", content: toolResults });
          continue;
        }

        // ── MAX_TOKENS mid-response ──────────────────────────────────────────
        // Claude was cut off. Force full budget for this round AND all future
        // rounds by setting accumulatedToolResultChars above threshold.
        if (response.stop_reason === "max_tokens") {
          console.log(`[${name}] hit token limit on step ${steps}, re-requesting with full budget`);
          accumulatedToolResultChars = LARGE_CONTEXT_THRESHOLD + 1; // force full budget forever
          messages.pop();

          const retryResponse = await client.messages.create({
            model, max_tokens: finalTokens, system, tools: anthropicTools, messages,
          });
          messages.push({ role: "assistant", content: retryResponse.content });

          if (retryResponse.stop_reason === "end_turn") {
            const textBlock = retryResponse.content.find((b) => b.type === "text");
            return { answer: textBlock?.text ?? "", agentName: name, steps, model };
          }

          if (retryResponse.stop_reason === "tool_use") {
            const toolUseBlocks = retryResponse.content.filter((b) => b.type === "tool_use");
            const toolResults = await Promise.all(
              toolUseBlocks.map(async (block) => {
                const toolDef = toolDefs[block.name];
                if (!toolDef) return {
                  type: "tool_result", tool_use_id: block.id,
                  content: `Error: unknown tool "${block.name}"`, is_error: true,
                };
                try {
                  const result  = await toolDef.execute(block.input);
                  const content = JSON.stringify(result);
                  accumulatedToolResultChars += content.length;
                  return { type: "tool_result", tool_use_id: block.id, content };
                } catch (err) {
                  return {
                    type: "tool_result", tool_use_id: block.id,
                    content: `Error: ${err.message}`, is_error: true,
                  };
                }
              })
            );
            messages.push({ role: "user", content: toolResults });
            continue;
          }

          // Still max_tokens after retry — context genuinely too large
          console.warn(`[${name}] still max_tokens after retry — returning partial answer`);
          const textBlock = retryResponse.content.find((b) => b.type === "text");
          return {
            answer:    textBlock?.text ?? "Context too large to complete. Try a more specific query (e.g. specify the block name).",
            agentName: name,
            steps,
            model,
          };
        }

        // Unexpected stop reason
        console.warn(`[${name}] unexpected stop_reason=${response.stop_reason}`);
        const textBlock = response.content.find((b) => b.type === "text");
        return {
          answer:    textBlock?.text ?? `Stopped: ${response.stop_reason}`,
          agentName: name,
          steps,
          model,
        };
      }

      // Hit maxSteps
      console.warn(`[${name}] hit maxSteps=${maxSteps}, requesting final answer`);
      messages.push({ role: "user", content: "Please provide your final answer based on the information gathered so far." });
      const finalResponse = await client.messages.create({
        model, max_tokens: finalTokens, system, messages,
      });
      const textBlock = finalResponse.content.find((b) => b.type === "text");
      return {
        answer:    textBlock?.text ?? "Max steps reached without a final answer.",
        agentName: name,
        steps,
        model,
      };
    },
  };
}

/**
 * @typedef {Object} AgentResult
 * @property {string} answer    - Final text answer
 * @property {string} agentName - Agent name
 * @property {number} steps     - Tool-call rounds used
 * @property {string} model     - Model string used
 */