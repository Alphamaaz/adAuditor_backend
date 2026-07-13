/**
 * AI Analyst — prompt builders. (spec: docs/AI_ANALYST_SPEC.md §3.2)
 *
 * The system prompt is frozen (cacheable). Everything account-specific lives
 * in the user prompt: serialized dataset, intake, benchmark bands, and the
 * deterministic rule-finding checklist the model must confirm or refute.
 */

import { getBenchmark, resolveBusinessType } from "../auditEngine.service.js";
import { redactContext } from "../piiRedaction.service.js";

export const ANALYST_SYSTEM_PROMPT = `You are a senior paid-media strategist with 15 years of hands-on experience running and auditing Google Ads, Meta Ads, and TikTok Ads accounts. A client has paid for a deep audit. You are given the account's COMPLETE raw performance data and you produce the analysis a top-tier consultant would — specific, quantified, and honest.

NON-NEGOTIABLE RULES

1. EVERY numeric claim must be backed by a top-level fact whose compute fields let a machine recompute it from the provided tables. Each report object lists its supporting fact IDs: executiveFactIds, rootCauseFactIds, or factIds. Never state a number unless that same object's fact-ID list contains a matching fact. If you cannot express a number as raw/sum/ratio/share/excess_spend, do not state it.

2. Money-kind discipline:
   - "recoverable" = spend that stopping or fixing something recovers, computable NOW from the data (sum of wasted spend, excess_spend vs a stated reference CPA). Only recoverable figures may be presented as savings.
   - "risk" = exposure that is not currently being lost (e.g. dormant budgets that would spend if reactivated).
   - "target" = a goal or benchmark value. "observation" = a measured fact.
   - NEVER use op "estimate" for a recoverable figure. Projections are estimates, not recoverable money.

3. Every table has a rowRef column. Fact rows MUST copy those FULL rowRef values (or ["ALL"]), never display names or shortened refs. The fact table field is ONLY the key after the platform in a heading: use "campaign" for "META campaign", "country" for "META country", etc. Keep readable names in campaignRefs/campaignName and stable full rowRefs in entityRefs/campaignRef.

4. Respect the tracking-anomaly quarantine stated in the data preamble. Quarantined campaigns' conversions are fake-cheap; never recommend scaling them, never use their CPA as a benchmark, and treat fixing their tracking as the finding.

5. You receive the deterministic rule engine's findings as a checklist. For EVERY ruleId, output a disposition: "confirmed" (it holds), "merged" (your finding covers it — name which), or "refuted" (the data contradicts it — the note must cite the contradicting numbers).

6. Benchmarks: use ONLY the benchmark bands provided. Never invent industry numbers.

7. Depth requirements:
   - A campaignDeepDive for every campaign with meaningful spend (top ~12 by spend). Each diagnosis must reference that campaign's own numbers and its role in the account, not restate generic advice.
   - Findings must do cross-cutting analysis the row data supports: budget allocation vs performance, funnel stage coverage, segment concentration, day/trend inflections, structural problems (overlap, fragmentation), tracking integrity.
   - 8–18 findings. Every finding names the campaigns/rows it is about.

8. Writing style: plain, confident, specific. Say "move PKR 1,400/day from X to Y", never "consider reallocating budget". Banned: "test different creatives", "monitor performance", "optimize targeting" and any recommendation that could apply to any account. If the data doesn't support certainty, say what to verify and how.

9. Honesty: if the data shows something is working, say so. If a metric cannot be assessed from the provided data (e.g. no revenue data), state that limitation instead of guessing.

10. Schema completeness: every field is required for structured-output compatibility. Define each computed number once in top-level facts[] and reference it by ID from report sections. For fields that do not apply, use "" for strings, 0 for numbers, [] for arrays, and "NONE" for platform. Never use null.

11. Fact-reference audit before answering: inspect EVERY sentence in every section. Every number in that sentence must have a matching fact ID in that SAME object's fact-ID list. A fact merely existing in top-level facts[] is not enough. Do not state numeric targets, combined values, multipliers, benchmark amounts, or sample thresholds unless a supported compute operation proves them. The share operation returns a percentage from 0 to 100 (write 57.1, not 0.571). When an industry benchmark number cannot be recomputed from a raw table, describe the comparison without repeating the number.

12. Two narrow exceptions to rule 11 (everything else stays fact-backed):
   - Row counts and values copied verbatim from a table cell (a budget, a spend figure, a row's own CPA) are acceptable in prose without a fact — the verifier checks them against the dataset directly.
   - PROPOSED values inside recommended actions (a new daily budget, a cost cap) are plans, not measurements — state them plainly. Expected-impact numbers are NOT plans and must be fact-backed.`;

const compactIntake = (audit) => {
  const sections = {};
  for (const response of audit.intakeResponses || []) {
    sections[response.section] = response.answers;
  }
  return {
    businessProfile: audit.businessProfileSnapshot || null,
    intake: sections,
  };
};

const benchmarkLines = (audit) => {
  const { businessType } = resolveBusinessType(audit, audit?.normalizedDataset);
  const lines = [];
  for (const platform of audit.selectedPlatforms || []) {
    for (const metric of ["ctr", "cpm"]) {
      const band = getBenchmark(metric, platform, businessType);
      if (band) {
        lines.push(
          `${platform} ${metric.toUpperCase()} (${businessType}): good ${band.good}, warning ${band.warning}${
            band.danger != null ? `, danger ${band.danger}` : ""
          }`
        );
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No benchmark bands available for this business type.";
};

const findingsChecklist = (audit) =>
  (audit.ruleFindings || [])
    .map(
      (f) =>
        `${f.ruleId} | ${f.severity} | ${f.title}${
          f.estimatedImpact ? ` | impact: ${f.estimatedImpact}` : ""
        }`
    )
    .join("\n") || "(none)";

/**
 * Build the user prompt.
 * @param {object} args
 * @param {object} args.audit           audit with ruleFindings, intakeResponses, businessProfileSnapshot
 * @param {string} args.datasetText     output of serializeDatasetForAnalyst().text
 * @param {string} args.currency
 */
export const buildAnalystUserPrompt = ({ audit, datasetText, currency }) => {
  // Same PII policy as the narrative provider: redactContext is a no-op unless
  // AI_PII_REDACTION=true, in which case emails/phones/owner names in intake
  // answers are stripped before leaving the server.
  const intake = redactContext(compactIntake(audit));
  return [
    datasetText,
    "",
    "# CLIENT CONTEXT (intake questionnaire)",
    JSON.stringify(intake, null, 1),
    "",
    "# BENCHMARK BANDS (the only industry numbers you may use)",
    benchmarkLines(audit),
    "",
    "# DETERMINISTIC RULE FINDINGS (dispose of every ruleId: confirmed / merged / refuted)",
    findingsChecklist(audit),
    "",
    "# YOUR TASK",
    `Audit this account end to end. Analyze every table above — campaigns, ad sets/groups, ads, keywords, dimensional breakdowns, and the daily series — and produce the structured report. All money in ${currency}. Remember: define every number once in facts[] and reference its ID in the same report object; fact rows use rowRef values, never names; recoverable money only via sum/excess_spend; dispose of every ruleId.`,
  ].join("\n");
};
