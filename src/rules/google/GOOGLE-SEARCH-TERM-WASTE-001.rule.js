/**
 * GOOGLE-SEARCH-TERM-WASTE-001
 *
 * Identifies search terms with meaningful spend that produced zero
 * conversions — typically the single highest-ROI finding on Google
 * accounts. Acted on via negative keywords.
 *
 * Detection:
 *   - Iterate Google records at level="search_term"
 *   - A term is "wasted" if:
 *       spend  >= MIN_SPEND_PER_TERM
 *       clicks >= MIN_CLICKS_PER_TERM  (statistical significance gate)
 *       conversions === 0
 *   - Aggregate wasted spend; fire when wasted/total >= AGGREGATE_SHARE_FIRE
 *
 * Severity ladder (share of total search-term spend):
 *   >= 20%  → CRITICAL
 *   >= 10%  → HIGH
 *   >=  5%  → MEDIUM
 *
 * Estimated savings: wasted × RECOVERY_FACTOR (80%).
 */

import { getRecordsByLevel } from "../shared/context-helpers.js";
import { numberValue } from "../shared/numeric.js";
import { pickSeverity } from "../shared/severityLadder.js";
import { dollar, percent, moneyImpactLine } from "../shared/impactText.js";
import { GOOGLE_SEARCH_TERM_WASTE as T } from "../shared/thresholds/google.js";
import { isSignificant } from "../../lib/stats/significance.js";

const SEVERITY_LADDER = [
  [T.AGGREGATE_SHARE_CRITICAL, "CRITICAL"],
  [T.AGGREGATE_SHARE_HIGH, "HIGH"],
  [T.AGGREGATE_SHARE_FIRE, "MEDIUM"],
];

export default {
  id: "GOOGLE-SEARCH-TERM-WASTE-001",
  version: "1.0.0",
  platforms: ["GOOGLE"],
  category: "Keyword Strategy",
  severity: "HIGH", // default; per-finding dynamic via pickSeverity
  minPlanTier: "free",
  estimatedImpactRange: { min: 500, max: 100000 },
  confidence: "high",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "moderate",
  tags: ["money-rule", "google", "keyword-strategy"],
  contextVersion: "v1",

  eval(ctx) {
    const searchTerms = getRecordsByLevel(ctx.dataset, "GOOGLE", "search_term");
    if (!searchTerms || searchTerms.length === 0) return null;

    let totalSearchTermSpend = 0;
    const wasted = [];
    for (const term of searchTerms) {
      const spend = numberValue(term.spend);
      const clicks = numberValue(term.clicks);
      const conversions = numberValue(term.conversions);
      totalSearchTermSpend += spend;
      if (
        spend >= T.MIN_SPEND_PER_TERM &&
        clicks >= T.MIN_CLICKS_PER_TERM &&
        conversions === 0
      ) {
        wasted.push({ term, spend, clicks });
      }
    }

    if (totalSearchTermSpend < T.MIN_TOTAL_SEARCH_TERM_SPEND) return null;
    if (wasted.length === 0) return null;

    const wastedSpend = wasted.reduce((sum, w) => sum + w.spend, 0);
    const wastedShare = wastedSpend / totalSearchTermSpend;
    const severity = pickSeverity(wastedShare, SEVERITY_LADDER);
    if (!severity) return null;

    // Significance gate (proof-of-pattern): is the wasted-conversion signal
    // backed by enough clicks to trust? Sum clicks on the zero-conversion
    // terms and check against the CVR minimum-sample gate. Non-blocking —
    // we surface confidence in the evidence rather than suppressing.
    const wastedClicks = wasted.reduce((sum, w) => sum + w.clicks, 0);
    const significance = isSignificant({
      metric: "cvr",
      denominator: wastedClicks,
    });

    // Top-N examples by spend (deterministic ordering).
    const examples = [...wasted]
      .sort((a, b) => b.spend - a.spend)
      .slice(0, T.EXAMPLES_COUNT)
      .map((w) => ({
        term: w.term.name,
        spend: Math.round(w.spend),
        clicks: w.clicks,
        conversions: 0,
      }));

    return {
      ruleId: "GOOGLE-SEARCH-TERM-WASTE-001",
      platform: "GOOGLE",
      severity,
      category: "Keyword Strategy",
      title: `${dollar(wastedSpend)} of Google search-term spend produced zero conversions`,
      detail:
        `${wasted.length} search term(s) consumed ${dollar(wastedSpend)} ` +
        `(${percent(wastedShare)} of total Google search-term spend) ` +
        `without recording a single conversion. These are negative-keyword candidates.`,
      evidence: {
        wastedSpend: Math.round(wastedSpend),
        wastedTermCount: wasted.length,
        wastedShare: Number(wastedShare.toFixed(4)),
        totalSearchTermSpend: Math.round(totalSearchTermSpend),
        examples,
        thresholds: {
          minSpendPerTerm: T.MIN_SPEND_PER_TERM,
          minClicksPerTerm: T.MIN_CLICKS_PER_TERM,
        },
        significance: {
          wastedClicks,
          sampleSignificant: significance.significant,
          minClicksForConfidence: significance.min,
        },
      },
      estimatedImpact: moneyImpactLine({
        identifiedAmount: wastedSpend,
        recoveryFactor: T.RECOVERY_FACTOR,
      }),
      fixSteps: [
        "Export the wasted search-term list from Google Ads (Keywords → Search terms).",
        "Add each zero-conversion term as a negative keyword at the campaign level.",
        "Cluster recurring zero-conversion patterns into negative keyword lists for reuse.",
        "Re-audit in 14 days to verify the recovered spend has shifted to converting terms.",
      ],
    };
  },
};
