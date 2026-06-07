/**
 * Deep Audit — prompts + the terminal conclusion tool. (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * The system prompt is frozen (no timestamps / per-request IDs) so it caches.
 * The hard invariants live here because they are the core value: the model
 * never does arithmetic, it must disconfirm before concluding, and it concludes
 * only by calling `concludeAudit` (structured output, not free-text JSON).
 */

export const SYSTEM_PROMPT = `You are a senior paid-media strategist running a DEEP AUDIT of one ad account.

You reason in a loop: state the single most likely top problem and a hypothesis for its ROOT CAUSE, call deterministic tools to confirm it, then deliberately try to DISCONFIRM it, revise, and conclude with a confidence level.

HARD RULES — these are non-negotiable:
1. You NEVER do arithmetic. Every number you cite must come from a tool result. Do not estimate, average, or infer figures yourself.
2. You have no raw ad rows — only the computed aggregates the tools return. Reason over those.
3. Before you conclude, you MUST run at least one DISCONFIRMING check: call a tool whose result could contradict your current hypothesis. A confident-but-untested conclusion is a failure.
4. Distinguish references. "CTR is fine vs the industry benchmark" and "CTR is the lever vs a better peer account" can both be true — say which reference you mean.
5. Conclude ONLY by calling the concludeAudit tool. Do not write the final report as prose. Every dollar or metric in the conclusion must trace to a tool result.

Work the loop: HYPOTHESIZE → TEST (decomposeKpi / analyzeSegments / getPeerComparison / getBenchmark / checkSignificance) → DISCONFIRM → REVISE → conclude. Prefer the smallest set of tool calls that genuinely tests the hypothesis. Be specific and honest; if the data is thin, say so and lower your confidence.`;

/** The seed user turn: the curated evidence packet + the task. */
export const buildSeedMessage = (evidencePacket) =>
  `Here is the deterministic evidence packet for this account (no raw rows, every number already computed):

${JSON.stringify(evidencePacket, null, 2)}

Diagnose the single biggest problem and its root cause. Start by stating your top hypothesis, then test it with the tools.`;

/** Injected once, after the first test, to force the disconfirmation step. */
export const DISCONFIRM_INSTRUCTION =
  "Now actively try to DISCONFIRM your current hypothesis. Call a tool whose result could contradict it — for example, check a different reference (peer vs benchmark), decompose a different KPI, or test significance of the sample the hypothesis rests on. You must run this disconfirming check before you may conclude.";

/** Injected when the loop must wrap up (budget/iteration cap or natural stop). */
export const CONCLUDE_INSTRUCTION =
  "Conclude now by calling the concludeAudit tool with your final diagnosis. Ground every figure in the tool results you have gathered.";

/**
 * Terminal tool. The model "submits" its report as structured input here, which
 * the orchestrator validates — far safer than parsing free-text JSON. This is
 * handled by the orchestrator, not the deterministic tool layer.
 */
export const CONCLUDE_TOOL = {
  name: "concludeAudit",
  description:
    "Submit the final audit conclusion. Call this ONLY after you have tested your top hypothesis AND run at least one disconfirming check. Every number must come from a tool result.",
  input_schema: {
    type: "object",
    properties: {
      headline: {
        type: "string",
        description: "The single biggest problem, in one sentence.",
      },
      rootCause: {
        type: "string",
        description: "The diagnosed root cause, grounded in tool results.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      drivers: {
        type: "string",
        description:
          "What the KPI decomposition / segment analysis showed — cite the tool numbers and which reference (peer vs benchmark) you used.",
      },
      recommendations: {
        type: "array",
        description: "Prioritized fixes, highest-leverage first.",
        items: {
          type: "object",
          properties: {
            action: { type: "string" },
            rationale: { type: "string" },
            estimatedImpact: { type: "string" },
          },
          required: ["action"],
          additionalProperties: false,
        },
      },
    },
    required: ["headline", "rootCause", "confidence", "recommendations"],
    additionalProperties: false,
  },
};
