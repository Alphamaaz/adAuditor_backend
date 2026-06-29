import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * Two Google parity features (vs the Claude-MCP benchmark):
 *  - target-CPA inference: when intake declares no target, infer the account
 *    target from the campaigns' own Target-CPA settings so "CPA vs target" can
 *    still fire (disclosed as inferred);
 *  - dead-campaign hygiene: flag the zero-delivery campaign clutter.
 */
const googleAudit = ({ campaigns, declaredTarget = null }) => ({
  id: "aud_parity",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: declaredTarget } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 90000, conversions: 670, currency: "PKR" },
      platforms: { GOOGLE: { spend: 90000, conversions: 670, clicks: 9000, impressions: 150000, currency: "PKR" } },
    },
    data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns }, byDimension: {}, byDay: [] } } },
  },
});

const liveCampaigns = [
  { level: "campaign", name: "BD | Signals", spend: 30000, conversions: 360, impressions: 60000, clicks: 3600, cpa: 83, targetCpa: 80 },
  { level: "campaign", name: "IND | Signals", spend: 18000, conversions: 130, impressions: 40000, clicks: 2400, cpa: 138, targetCpa: 95 },
  { level: "campaign", name: "PK | Signals", spend: 42000, conversions: 180, impressions: 50000, clicks: 3000, cpa: 233, targetCpa: 100 },
];
// 4 zero-delivery shells.
const deadCampaigns = Array.from({ length: 4 }, (_, i) => ({
  level: "campaign", name: `OLD | Test ${i + 1}`, spend: 0, conversions: 0, impressions: 0, clicks: 0,
}));

describe("Google target-CPA inference", () => {
  it("infers the account target from campaign tCPA settings when intake has none", () => {
    const { findings } = runDeterministicAudit(googleAudit({ campaigns: liveCampaigns }));
    const diag = findings.find((f) => f.ruleId === "DIAG-CPA-001");
    expect(diag).toBeDefined();
    expect(diag.evidence.targetSource).toBe("inferred");
    expect(diag.evidence.targetCpa).toBe(95); // median of 80, 95, 100
  });

  it("prefers the declared intake target over the inferred one", () => {
    const { findings } = runDeterministicAudit(googleAudit({ campaigns: liveCampaigns, declaredTarget: 50 }));
    const diag = findings.find((f) => f.ruleId === "DIAG-CPA-001");
    expect(diag.evidence.targetSource).toBe("declared");
    expect(diag.evidence.targetCpa).toBe(50);
  });

  it("does not invent a target when no campaign carries a tCPA", () => {
    const noTcpa = liveCampaigns.map(({ targetCpa, ...c }) => c);
    const { findings } = runDeterministicAudit(googleAudit({ campaigns: noTcpa }));
    expect(findings.find((f) => f.ruleId === "DIAG-CPA-001")).toBeUndefined();
  });
});

const fragAudit = (audiencePerf) => ({
  id: "aud_frag",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 90000, conversions: 600, currency: "PKR" },
      platforms: { GOOGLE: { spend: 90000, conversions: 600, clicks: 9000, impressions: 150000, currency: "PKR" } },
    },
    data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: liveCampaigns, audience_performance: audiencePerf }, byDimension: {}, byDay: [] } } },
  },
});

describe("Google audience fragmentation", () => {
  it("flags an ad group crammed with audiences where most convert nothing", () => {
    // 8 segments in one ad group, 6 with zero conversions, material spend.
    const rows = Array.from({ length: 8 }, (_, i) => ({
      level: "audience_performance", adGroupId: "AG1", adGroupName: "Ad group 1", campaignName: "PK | Signals",
      criterionId: `c${i}`, spend: 1200, clicks: 200, conversions: i < 2 ? 10 : 0,
    }));
    const { findings } = runDeterministicAudit(fragAudit(rows));
    const f = findings.find((x) => x.ruleId === "GOOGLE-FRAG-001");
    expect(f).toBeDefined();
    expect(f.evidence.segmentCount).toBe(8);
    expect(f.evidence.zeroConversionSegments).toBe(6);
  });

  it("does not flag a cleanly-isolated ad group (few segments)", () => {
    const rows = [
      { level: "audience_performance", adGroupId: "AG1", adGroupName: "Ad group 1", campaignName: "BD | Signals", criterionId: "c1", spend: 15000, clicks: 1800, conversions: 180 },
      { level: "audience_performance", adGroupId: "AG2", adGroupName: "Ad group 2", campaignName: "BD | Signals", criterionId: "c2", spend: 12000, clicks: 1500, conversions: 140 },
    ];
    expect(runDeterministicAudit(fragAudit(rows)).findings.find((x) => x.ruleId === "GOOGLE-FRAG-001")).toBeUndefined();
  });
});

describe("Google dead-campaign hygiene", () => {
  it("flags zero-delivery campaign clutter", () => {
    const { findings } = runDeterministicAudit(googleAudit({ campaigns: [...liveCampaigns, ...deadCampaigns] }));
    const hyg = findings.find((f) => f.ruleId === "GOOGLE-HYGIENE-001");
    expect(hyg).toBeDefined();
    expect(hyg.severity).toBe("LOW");
    expect(hyg.evidence.deadCampaignCount).toBe(4);
  });

  it("does not fire when there is no material dead-campaign clutter", () => {
    const { findings } = runDeterministicAudit(googleAudit({ campaigns: liveCampaigns }));
    expect(findings.find((f) => f.ruleId === "GOOGLE-HYGIENE-001")).toBeUndefined();
  });
});
