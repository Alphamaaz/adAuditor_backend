/**
 * Deep Audit - prompts + the terminal conclusion tool. (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * The system prompt is frozen (no timestamps / per-request IDs) so it caches.
 * The hard invariants live here because they are the core value: the model
 * never does arithmetic, it must disconfirm before concluding, and it concludes
 * only by calling `concludeAudit` (structured output, not free-text JSON).
 */

export const SYSTEM_PROMPT = `You are a senior paid-media strategist running a DEEP AUDIT of one ad account.

You reason in a loop: state the single most likely top problem and a hypothesis for its ROOT CAUSE, call deterministic tools to confirm it, then deliberately try to DISCONFIRM it, revise, and conclude with a confidence level.

HARD RULES - these are non-negotiable:
1. You NEVER do arithmetic. Every number you cite must come from a tool result. Do not estimate, average, or infer figures yourself.
2. You have no raw ad rows - only the computed aggregates the tools return. Reason over those.
3. Before you conclude, you MUST run at least one DISCONFIRMING check: call a tool whose result could contradict your current hypothesis. A confident-but-untested conclusion is a failure.
4. Distinguish references. "CTR is fine vs the industry benchmark" and "CTR is the lever vs a better peer account" can both be true - say which reference you mean.
5. Conclude ONLY by calling the concludeAudit tool. Do not write the final report as prose. Every dollar or metric in the conclusion must trace to a tool result.
6. NO baseline = no "dominant driver." If decomposeKpi reports comparison.available = false, or getPeerComparison is unavailable, there is no peer to measure a gap against - do NOT name a single dominant driver (for example, "CPM is the problem") as the root cause. Say plainly that no comparable peer was available, lean on the benchmark diagnosis, the segment analysis, and the deterministic findings, and lower your confidence accordingly.
7. If the evidence packet contains a zero-impression keyword finding (for example KW-010), call analyzeCampaignTypes before concluding. Resolve where spend and conversions actually come from before saying the keyword foundation is the root cause.
8. For money figures from segment or campaign-type tools, cite formatted fields such as estimatedWasteFormatted, spendFormatted, totalSpendFormatted, cpaFormatted, and baselineCpaFormatted. Do not reconstruct currency strings yourself.

WRITING STYLE - write for a busy agency owner, not an analyst:
- Lead with the money. The headline names the biggest figure at stake in the account's currency or, if nothing is quantifiable, the single clearest lever. Never invent a number - if the tools did not produce one, say so and lead with the lever.
- Use the account's actual currency from the evidence packet and tool results, for example PKR. Never assume "$".
- Plain English. Translate the tool output into what a marketer understands - say "your cost per result is driven by what you pay for impressions, not by clicks" instead of "dominant driver CPM at 100% contribution". Never use raw field names such as "estimatedImpactDollars", "contributionPct", "decomposition", or "ln-space".
- Be decisive. One clear top problem and what to do about it. Drop "may / could / potentially" unless your confidence is genuinely low - and if it is, say why.
- Keep it tight. The reader should grasp the headline and the top fix in about ten seconds.

Work the loop: HYPOTHESIZE -> TEST (decomposeKpi / analyzeSegments / analyzeCampaignTypes / getPeerComparison / getBenchmark / checkSignificance) -> DISCONFIRM -> REVISE -> conclude. Prefer the smallest set of tool calls that genuinely tests the hypothesis. Be specific and honest; if the data is thin, say so and lower your confidence.`;

/** The seed user turn: the curated evidence packet + the task. */
export const buildSeedMessage = (evidencePacket) =>
  `Here is the deterministic evidence packet for this account (no raw rows, every number already computed):

${JSON.stringify(evidencePacket, null, 2)}

Diagnose the single biggest problem and its root cause. Start by stating your top hypothesis, then test it with the tools.`;

/** Injected once, after the first test, to force the disconfirmation step. */
export const DISCONFIRM_INSTRUCTION =
  "Now actively try to DISCONFIRM your current hypothesis. Call a tool whose result could contradict it - for example, check a different reference (peer vs benchmark), decompose a different KPI, analyze campaign types, or test significance of the sample the hypothesis rests on. You must run this disconfirming check before you may conclude.";

/** Injected when the loop must wrap up (budget/iteration cap or natural stop). */
export const CONCLUDE_INSTRUCTION =
  "Conclude now by calling the concludeAudit tool with your final diagnosis. Ground every figure in the tool results you have gathered.";

/**
 * Terminal tool. The model "submits" its report as structured input here, which
 * the orchestrator validates - far safer than parsing free-text JSON. This is
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
        description:
          "One plain-English sentence a client grasps in five seconds. Lead with the biggest figure at stake in the account's currency (or the clearest lever if nothing is quantifiable). No jargon, no field names.",
      },
      rootCause: {
        type: "string",
        description:
          "The root cause in plain language, grounded in tool results. Translate the numbers rather than quoting raw metrics. Name which reference you used (peer vs benchmark); if no peer was available, say so and lower confidence.",
      },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      drivers: {
        type: "string",
        description:
          "Optional. The supporting numbers behind the root cause, in plain terms - cite the actual figures and the account's currency, not raw field names.",
      },
      recommendations: {
        type: "array",
        description: "Prioritized fixes, highest dollar impact first.",
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              description:
                "The concrete change to make, in the imperative - for example, 'Cut the Display network because it spent PKR X for Y conversions'.",
            },
            rationale: {
              type: "string",
              description: "One line of why, grounded in a tool result.",
            },
            estimatedImpact: {
              type: "string",
              description:
                "The money at stake in the account's currency, from a tool result. If not quantifiable, write 'impact not quantifiable from available data' - never invent a figure.",
            },
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
