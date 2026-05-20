// src/agents/agent-factory.js
// Re-exports createAgent from agent-runner.js.
// The 5 agent files import from here — this keeps their imports unchanged.
export { createAgent } from "./agent-runner.js";