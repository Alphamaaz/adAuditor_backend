import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

// Simulates a STORED dataset built before the messaging-reconcile fix existed:
// the hiring campaign was lead-counted at pull time (11), even though its ad sets
// optimise for CONVERSATIONS (messaging, 90 total). Audit runs reuse this stored
// dataset and never re-pull, so the engine must self-heal it on the fly.
const storedAudit = () => {
  const campaigns = [
    { level: "campaign", name: "LP Leads A", status: "ACTIVE", resultFamily: "lead", spend: 60000, results: 520, impressions: 120000, clicks: 4800, cpa: 115 },
    { level: "campaign", name: "LP Leads B", status: "ACTIVE", resultFamily: "lead", spend: 50000, results: 450, impressions: 100000, clicks: 4000, cpa: 111 },
    // Hiring campaign: stored as 11 "leads" (the undercount).
    { level: "campaign", name: "Sales Person Hiring", status: "ACTIVE", resultFamily: "lead", spend: 1300, results: 11, impressions: 3000, clicks: 400, cpa: 118 },
  ];
  const adsets = [
    { level: "adset", name: "a1", campaignName: "LP Leads A", resultFamily: "lead", spend: 60000, results: 520, cpa: 115 },
    { level: "adset", name: "b1", campaignName: "LP Leads B", resultFamily: "lead", spend: 50000, results: 450, cpa: 111 },
    // Hiring ad sets optimise for CONVERSATIONS → messaging, 90 conversations.
    { level: "adset", name: "h1", campaignName: "Sales Person Hiring", optimizationGoal: "CONVERSATIONS", resultFamily: "messaging", spend: 1300, results: 90, cpa: 14 },
  ];
  return {
    selectedPlatforms: ["META"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen" } },
    intakeResponses: [],
    normalizedDataset: {
      data: { platforms: { META: { byLevel: { campaign: campaigns, adset: adsets }, records: [...campaigns, ...adsets] } } },
      summary: {
        platforms: { META: { spend: 111300, conversions: 981, impressions: 223000, clicks: 9200, currency: "PKR" } },
        totals: { spend: 111300, conversions: 981, currency: "PKR" },
      },
    },
  };
};

describe("engine-time normalization self-heal", () => {
  it("reconciles a stored messaging campaign's results without a re-pull", () => {
    const audit = storedAudit();
    runDeterministicAudit(audit); // mutates the dataset in place
    const hiring = audit.normalizedDataset.data.platforms.META.byLevel.campaign.find(
      (c) => c.name === "Sales Person Hiring"
    );
    expect(hiring.results).toBe(90); // upgraded from 11
    expect(hiring.resultFamily).toBe("messaging");
    expect(hiring.resultsReconciledFrom).toBe("adset_optimization_goal");
  });

  it("flows the corrected count into the conversion totals", () => {
    const audit = storedAudit();
    runDeterministicAudit(audit);
    // 981 - 11 + 90 = 1060
    expect(audit.normalizedDataset.summary.platforms.META.conversions).toBe(1060);
    expect(audit.normalizedDataset.summary.totals.conversions).toBe(1060);
  });

  it("is idempotent — a second run does not double-count", () => {
    const audit = storedAudit();
    runDeterministicAudit(audit);
    runDeterministicAudit(audit);
    expect(audit.normalizedDataset.summary.totals.conversions).toBe(1060);
  });

  it("does not touch genuine lead campaigns", () => {
    const audit = storedAudit();
    runDeterministicAudit(audit);
    const a = audit.normalizedDataset.data.platforms.META.byLevel.campaign.find((c) => c.name === "LP Leads A");
    expect(a.results).toBe(520);
    expect(a.resultsReconciledFrom).toBeUndefined();
  });
});
