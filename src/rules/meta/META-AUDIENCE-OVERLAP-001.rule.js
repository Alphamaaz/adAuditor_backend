/**
 * META-AUDIENCE-OVERLAP-001
 *
 * Heuristic detection of likely audience overlap on Meta. The definitive
 * source is Meta's Audience Overlap report in Ads Manager, which we cannot
 * read via CSV exports. Instead, we infer from auction-fatigue signals:
 *
 *   - Multiple ad sets in the SAME campaign all running at high frequency
 *     (>= OVERLAP_FREQ 3.0) AND meaningful spend (>= MIN_ADSET_SPEND $100)
 *     strongly suggests they are competing in the same auction.
 *   - Intake signals M12 (similar lookalikes stacked) and M13 (stacked
 *     broad interests) corroborate.
 *
 * Detection:
 *   - Group ACTIVE ad sets by campaign name
 *   - Per campaign with >= MIN_ADSETS_PER_CAMPAIGN (2):
 *       count ad sets with freq >= OVERLAP_FREQ AND spend >= MIN_ADSET_SPEND
 *       If that count >= MIN_OVERLAP_ADSETS_PER_CAMPAIGN (2) → flag campaign
 *
 * Severity:
 *   HIGH if any campaign has >= HIGH_SEVERITY_AT (3) overlapping ad sets
 *        OR intake confirms (M12=yes OR M13 stacked/broad)
 *   MEDIUM otherwise
 */

import {
  getRecordsByLevel,
  getPlatformAnswers,
  isPausedStatus,
} from "../shared/context-helpers.js";
import { numberValue } from "../shared/numeric.js";
import { matchesWord, includesAny } from "../shared/text.js";
import { dollar, percent } from "../shared/impactText.js";
import { META_AUDIENCE_OVERLAP as T } from "../shared/thresholds/meta.js";

const intakeSignalsOverlap = (answers) => {
  const lookalikes = matchesWord(answers.M12, ["yes"]);
  const stacked = includesAny(answers.M13, ["many", "stacked", "broad"]);
  return { lookalikes, stacked, any: lookalikes || stacked };
};

export default {
  id: "META-AUDIENCE-OVERLAP-001",
  version: "1.0.0",
  platforms: ["META"],
  category: "Audience Strategy",
  severity: "HIGH",
  minPlanTier: "free",
  estimatedImpactRange: { min: 500, max: 50000 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "moderate",
  tags: ["money-rule", "meta", "audience"],
  contextVersion: "v1",

  eval(ctx) {
    const adsets = getRecordsByLevel(ctx.dataset, "META", "adset");
    if (adsets.length === 0) return null;

    const answers = getPlatformAnswers(ctx.audit, "META");
    const intakeSignals = intakeSignalsOverlap(answers);

    // Group ACTIVE ad sets by campaign name.
    const byCampaign = new Map();
    for (const a of adsets) {
      if (isPausedStatus(a.status)) continue;
      const cname = a.campaignName || "(unknown campaign)";
      const list = byCampaign.get(cname) ?? [];
      list.push(a);
      byCampaign.set(cname, list);
    }

    let maxOverlapInOneCampaign = 0;
    let totalOverlappingAdSets = 0;
    let totalOverlappingSpend = 0;
    const examples = [];

    for (const [cname, list] of byCampaign.entries()) {
      if (list.length < T.MIN_ADSETS_PER_CAMPAIGN) continue;
      const overlapping = list.filter(
        (a) =>
          numberValue(a.frequency) >= T.OVERLAP_FREQ &&
          numberValue(a.spend) >= T.MIN_ADSET_SPEND
      );
      if (overlapping.length < T.MIN_OVERLAP_ADSETS_PER_CAMPAIGN) continue;
      const campaignSpend = overlapping.reduce(
        (s, a) => s + numberValue(a.spend),
        0
      );
      totalOverlappingAdSets += overlapping.length;
      totalOverlappingSpend += campaignSpend;
      maxOverlapInOneCampaign = Math.max(
        maxOverlapInOneCampaign,
        overlapping.length
      );
      examples.push({
        campaign: cname,
        overlappingAdSets: overlapping.length,
        totalAdSets: list.length,
        avgFrequency: Number(
          (
            overlapping.reduce((s, a) => s + numberValue(a.frequency), 0) /
            overlapping.length
          ).toFixed(2)
        ),
        totalSpend: Math.round(campaignSpend),
      });
    }

    if (totalOverlappingAdSets === 0 && !intakeSignals.any) return null;
    // Require at least one data-side signal if no intake confirmation —
    // intake-only is too weak on its own.
    if (totalOverlappingAdSets === 0 && intakeSignals.any) return null;

    const severity =
      maxOverlapInOneCampaign >= T.HIGH_SEVERITY_AT || intakeSignals.any
        ? "HIGH"
        : "MEDIUM";

    // Deterministic ordering for examples
    examples.sort((a, b) => b.totalSpend - a.totalSpend);
    const exampleSubset = examples.slice(0, T.EXAMPLES_COUNT);

    const recovered = totalOverlappingSpend * T.RECOVERY_FACTOR;

    const signalSources = [];
    if (totalOverlappingAdSets > 0) signalSources.push("frequency_spend_data");
    if (intakeSignals.lookalikes) signalSources.push("intake_M12_lookalikes");
    if (intakeSignals.stacked) signalSources.push("intake_M13_interests");

    return {
      ruleId: "META-AUDIENCE-OVERLAP-001",
      platform: "META",
      severity,
      category: "Audience Strategy",
      title: `Likely audience overlap detected on ${dollar(totalOverlappingSpend)} of Meta spend`,
      detail:
        `${totalOverlappingAdSets} ad set(s) across ${examples.length} campaign(s) ` +
        `show auction-fatigue signals (frequency >= ${T.OVERLAP_FREQ}, spend >= ${dollar(T.MIN_ADSET_SPEND)}). ` +
        `Multiple active ad sets in the same campaign at sustained high frequency typically ` +
        `compete in the same auction, inflating CPMs and producing duplicate impressions to the same users.`,
      evidence: {
        campaignsAffected: examples.length,
        totalOverlappingAdSets,
        maxOverlapInOneCampaign,
        totalOverlappingSpend: Math.round(totalOverlappingSpend),
        signalSources,
        intakeSignals: {
          M12: answers.M12 ?? null,
          M13: answers.M13 ?? null,
        },
        examples: exampleSubset,
        thresholds: {
          overlapFrequency: T.OVERLAP_FREQ,
          minAdsetSpend: T.MIN_ADSET_SPEND,
          minOverlapAdsetsPerCampaign: T.MIN_OVERLAP_ADSETS_PER_CAMPAIGN,
        },
      },
      estimatedImpact:
        `${dollar(totalOverlappingSpend)} of Meta spend shows overlap signals. ` +
        `Consolidating overlapping ad sets typically recovers ${percent(T.RECOVERY_FACTOR, 0)} ` +
        `(${dollar(recovered)}) within 2 weeks via reduced CPM auction pressure.`,
      fixSteps: [
        "Run Meta's Audience Overlap report on the flagged campaigns to confirm overlap percentages.",
        "Consolidate ad sets with >25% overlap — pause the lower-performing one and reallocate budget.",
        "For broad-interest stacks: migrate to Advantage+ Audience where the objective allows.",
        "Add mutual-exclusion via exclusion audiences so prospecting and retargeting cannot compete in the same auction.",
        "Re-audit in 14 days to verify frequency has dropped and CPM has stabilized.",
      ],
    };
  },
};
