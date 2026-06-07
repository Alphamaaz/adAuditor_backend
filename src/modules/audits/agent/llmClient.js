/**
 * Deep Audit — Anthropic (Claude Opus) adapter. (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * Thin wrapper exposing a single `createMessage` the orchestrator depends on, so
 * the loop can be unit-tested with a fake client (no API key, deterministic).
 * The real SDK is imported LAZILY on first call — the module loads fine without
 * `@anthropic-ai/sdk` installed, which keeps the codebase green while the
 * feature is flag-gated off. Install the SDK before enabling DEEP_AUDIT_ENABLED.
 */

import { DEEP_AUDIT_MODEL, DEEP_AUDIT_EFFORT } from "./config.js";

let _client = null;

const getClient = async () => {
  if (_client) return _client;
  const mod = await import("@anthropic-ai/sdk");
  const Anthropic = mod.default;
  _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
};

/**
 * Build the production LLM client. Returns an object with `createMessage`,
 * which normalizes the Anthropic response to { content, stopReason, usage }.
 *
 * Opus 4.8 surface: adaptive thinking only (no budget_tokens), no sampling
 * params, effort via output_config. The frozen system prompt is cached.
 */
export const createAnthropicClient = () => ({
  async createMessage({ system, messages, tools, toolChoice }) {
    const client = await getClient();
    const res = await client.messages.create({
      model: DEEP_AUDIT_MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { effort: DEEP_AUDIT_EFFORT },
      system: [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ],
      tools,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      messages,
    });
    return {
      content: res.content,
      stopReason: res.stop_reason,
      usage: res.usage || {},
    };
  },
});
