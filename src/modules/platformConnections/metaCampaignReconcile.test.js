import { describe, it, expect } from "vitest";
import {
  reconcileCampaignResultsFromAdSets,
  buildMetaNormalizedDataset,
} from "./metaNormalizer.service.js";

// A hiring campaign with objective OUTCOME_LEADS but ad sets optimising for
// CONVERSATIONS: the campaign-level (objective-only) resolver picks the small
// incidental `lead` count (11), while the ad sets carry the real messaging volume
// (98). The ad-set optimisation goal is authoritative and must win.
const campaign = {
  level: "campaign",
  name: "New Leads campaign | Sales Person Hiring",
  objective: "OUTCOME_LEADS",
  spend: 1729,
  results: 11,
  resultFamily: "lead",
  cpa: 157.18,
};
const adSets = [
  {
    level: "adset",
    name: "Hiring – ad set A",
    campaignName: "New Leads campaign | Sales Person Hiring",
    optimizationGoal: "CONVERSATIONS",
    spend: 1000,
    results: 56,
    resultFamily: "messaging",
  },
  {
    level: "adset",
    name: "Hiring – ad set B",
    campaignName: "New Leads campaign | Sales Person Hiring",
    optimizationGoal: "CONVERSATIONS",
    spend: 729,
    results: 42,
    resultFamily: "messaging",
  },
];

describe("reconcileCampaignResultsFromAdSets", () => {
  it("upgrades a messaging-optimised 'leads' campaign to its real conversation count", () => {
    const [fixed] = reconcileCampaignResultsFromAdSets([campaign], adSets);
    expect(fixed.results).toBe(98);
    expect(fixed.resultFamily).toBe("messaging");
    expect(fixed.cpa).toBeCloseTo(1729 / 98, 1);
    expect(fixed.resultsReconciledFrom).toBe("adset_optimization_goal");
  });

  it("flows the corrected count into the account baseline (summary.conversions)", () => {
    const ds = buildMetaNormalizedDataset({
      campaignRecords: [campaign],
      adSetRecords: adSets,
      adRecords: [],
      currency: "PKR",
    });
    expect(ds.summary.totals.conversions).toBe(98);
  });

  it("does NOT override a genuine leads campaign whose ad sets also resolve to leads", () => {
    const leadsCampaign = { ...campaign, results: 40, resultFamily: "lead", cpa: 43.2 };
    const leadAdSets = adSets.map((a) => ({
      ...a,
      optimizationGoal: "OFFSITE_CONVERSIONS",
      resultFamily: "lead",
      results: 20,
    }));
    const [fixed] = reconcileCampaignResultsFromAdSets([leadsCampaign], leadAdSets);
    expect(fixed.resultFamily).toBe("lead");
    expect(fixed.results).toBe(40); // unchanged — same family, campaign count kept
    expect(fixed.resultsReconciledFrom).toBeUndefined();
  });

  it("does NOT override when ad sets cover too little of the campaign spend", () => {
    const sparse = [{ ...adSets[0], spend: 100, results: 98 }]; // 100/1729 ≈ 6% coverage
    const [fixed] = reconcileCampaignResultsFromAdSets([campaign], sparse);
    expect(fixed.results).toBe(11); // kept — partial pull must not undercount
    expect(fixed.resultFamily).toBe("lead");
  });

  it("is a no-op when there are no ad sets", () => {
    const [fixed] = reconcileCampaignResultsFromAdSets([campaign], []);
    expect(fixed).toEqual(campaign);
  });
});
