/**
 * Deep Audit — agentic orchestrator. (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * Drives Claude Opus through: SEED → HYPOTHESIZE → TEST → forced DISCONFIRM →
 * REVISE → CONCLUDE → VALIDATE, over the deterministic tool layer. The model
 * never computes; it can only obtain numbers via tools. The orchestrator owns
 * every guardrail:
 *   - forces at least one disconfirming tool call before a conclusion is accepted
 *   - enforces a token budget and a max-tool-call cap
 *   - records a factual reasoningTrace from the ACTUAL tool calls (not the
 *     model's self-report)
 *   - degrades to the standard single-shot report on any error, timeout,
 *     budget overrun, or validation failure — it can never do worse than standard.
 *
 * Pure control flow over an injected llmClient → unit-testable with a scripted
 * fake, no API key required.
 */

import { createDeepAuditTools, TOOL_SCHEMAS, runTool } from "./tools.js";
import { createAnthropicClient } from "./llmClient.js";
import {
  SYSTEM_PROMPT,
  buildSeedMessage,
  DISCONFIRM_INSTRUCTION,
  CONCLUDE_INSTRUCTION,
  CONCLUDE_TOOL,
} from "./prompts.js";
import {
  DEEP_AUDIT_TOKEN_BUDGET,
  DEEP_AUDIT_MAX_TOOL_CALLS,
} from "./config.js";

const CONCLUDE_TOOL_NAME = CONCLUDE_TOOL.name;

const usageTokens = (usage = {}) =>
  (Number(usage.input_tokens) || 0) +
  (Number(usage.output_tokens) || 0) +
  (Number(usage.cache_creation_input_tokens) || 0) +
  (Number(usage.cache_read_input_tokens) || 0);

const toolUseBlocks = (content = []) =>
  content.filter((b) => b && b.type === "tool_use");

const textOf = (content = []) =>
  content
    .filter((b) => b && b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();

/** Minimal structural validation. Real factuality/ruleId checks wire in later. */
const defaultValidate = (report) => {
  const ok =
    report &&
    typeof report.headline === "string" &&
    typeof report.rootCause === "string" &&
    Array.isArray(report.recommendations) &&
    report.recommendations.length > 0;
  return { valid: Boolean(ok), reason: ok ? null : "missing_required_fields" };
};

/**
 * Deterministic fallback. In production this returns the standard single-shot
 * AI report (the caller injects that generator); the default is an inert
 * sentinel so the orchestrator never throws.
 */
const defaultFallback = async ({ reason }) => ({
  mode: "fallback",
  report: null,
  reason,
});

/**
 * Run the Deep Audit loop for one audit bundle.
 *
 * @returns {Promise<{mode:"deep"|"fallback", report:object|null, reasoningTrace:Array, usage:object, reason?:string}>}
 */
export const runDeepAudit = async ({
  audit,
  priorAudits = [],
  llmClient = createAnthropicClient(),
  validate = defaultValidate,
  fallback = defaultFallback,
  tokenBudget = DEEP_AUDIT_TOKEN_BUDGET,
  maxToolCalls = DEEP_AUDIT_MAX_TOOL_CALLS,
} = {}) => {
  const reasoningTrace = [];
  const usage = {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 0,
    toolCalls: 0,
  };

  // Degrade to the standard path. Always attaches reasoningTrace + usage so the
  // result shape is stable regardless of what the injected fallback returns,
  // and never throws (a broken fallback still yields a usable result).
  const degrade = async (reason) => {
    let fb = {};
    try {
      fb = (await fallback({ reason, audit, reasoningTrace, usage })) || {};
    } catch {
      fb = {};
    }
    return {
      mode: "fallback",
      report: fb.report ?? null,
      // Keep the actual cause (error/budget/validation), not the generic note
      // the fallback returns — callers and the eval need to know WHY it degraded.
      reason,
      fallbackReason: fb.reason ?? null,
      reasoningTrace,
      usage,
    };
  };

  try {
    const tools = createDeepAuditTools({ audit, priorAudits });
    const modelTools = [...TOOL_SCHEMAS, CONCLUDE_TOOL];

    const evidencePacket = tools.getEvidencePacket();
    const messages = [
      { role: "user", content: buildSeedMessage(evidencePacket) },
    ];

    let disconfirmInjected = false;
    let disconfirmSatisfied = false;
    let forceConclude = false;
    let nextToolChoice; // undefined → auto

    const maxIterations = maxToolCalls + 5;

    for (let i = 0; i < maxIterations; i += 1) {
      // Budget gate — check BEFORE spending another call.
      if (usage.totalTokens >= tokenBudget) {
        return degrade("budget_exceeded");
      }

      const toolChoice = forceConclude
        ? { type: "tool", name: CONCLUDE_TOOL_NAME }
        : nextToolChoice;
      nextToolChoice = undefined;

      const res = await llmClient.createMessage({
        system: SYSTEM_PROMPT,
        messages,
        tools: modelTools,
        toolChoice,
      });

      usage.totalTokens += usageTokens(res.usage);
      usage.inputTokens +=
        (Number(res.usage?.input_tokens) || 0) +
        (Number(res.usage?.cache_creation_input_tokens) || 0) +
        (Number(res.usage?.cache_read_input_tokens) || 0);
      usage.outputTokens += Number(res.usage?.output_tokens) || 0;
      usage.turns += 1;

      const calls = toolUseBlocks(res.content);
      const hypothesis = textOf(res.content);

      // Always append the assistant turn verbatim (preserves tool_use blocks).
      messages.push({ role: "assistant", content: res.content });

      if (calls.length === 0) {
        // No tool call. If we already have what we need, force a conclusion;
        // otherwise nudge once toward concluding, then fall back.
        if (forceConclude) {
          return degrade("no_conclusion");
        }
        forceConclude = true;
        messages.push({ role: "user", content: CONCLUDE_INSTRUCTION });
        continue;
      }

      const toolResults = [];
      let conclusion = null;

      for (const call of calls) {
        if (call.name === CONCLUDE_TOOL_NAME) {
          if (disconfirmSatisfied || forceConclude) {
            conclusion = call.input;
            // No tool_result needed — we exit after accepting.
          } else {
            // Premature: must disconfirm first. Reject, keep the loop valid.
            toolResults.push({
              type: "tool_result",
              tool_use_id: call.id,
              is_error: true,
              content:
                "Premature conclusion. Run at least one disconfirming check first, then call concludeAudit again.",
            });
          }
          continue;
        }

        // Deterministic tool call.
        const result = runTool(tools, call.name, call.input || {});
        usage.toolCalls += 1;
        reasoningTrace.push({
          step: reasoningTrace.length + 1,
          hypothesis: hypothesis || undefined,
          tool: call.name,
          input: call.input || {},
          result,
          phase: disconfirmInjected ? "disconfirm" : "test",
        });
        if (disconfirmInjected) disconfirmSatisfied = true;
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(result),
        });
      }

      if (conclusion) {
        const verdict = validate(conclusion);
        if (verdict.valid) {
          return {
            mode: "deep",
            report: conclusion,
            reasoningTrace,
            usage,
            stopReason: res.stopReason,
          };
        }
        return degrade(`validation_failed:${verdict.reason || "invalid"}`);
      }

      // Feed tool results back.
      if (toolResults.length > 0) {
        messages.push({ role: "user", content: toolResults });
      }

      // Tool-call cap → force conclusion next turn.
      if (usage.toolCalls >= maxToolCalls) {
        forceConclude = true;
        messages.push({ role: "user", content: CONCLUDE_INSTRUCTION });
        continue;
      }

      // Force the disconfirmation step once, after the first real test.
      if (usage.toolCalls >= 1 && !disconfirmInjected) {
        disconfirmInjected = true;
        nextToolChoice = { type: "any" }; // must call a tool — can't conclude yet
        messages.push({ role: "user", content: DISCONFIRM_INSTRUCTION });
      }
    }

    return degrade("max_iterations");
  } catch (err) {
    return degrade(`error:${err?.message || String(err)}`);
  }
};

export const __test__ = { defaultValidate, usageTokens };
