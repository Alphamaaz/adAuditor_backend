import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * P3 polish rules (the MCP's §7 budget/bidding + structural hygiene + the
 * click-to-result insight). One Farooq-like fixture triggers all five.
 */
const polishAudit = () => {
  const campaigns = [
    { level: "campaign", name: "New Engagement Campaign", status: "PAUSED", bidStrategy: "LOWEST_COST_WITHOUT_CAP", spend: 7089, results: 161, linkClicks: 272 },
    { level: "campaign", name: "Pesh | WA | 23/5", status: "PAUSED", bidStrategy: "LOWEST_COST_WITH_BID_CAP", spend: 2928, results: 22, linkClicks: 104 },
    { level: "campaign", name: "Kingdom Testing", status: "PAUSED", bidStrategy: "LOWEST_COST_WITHOUT_CAP", spend: 1661, results: 0, linkClicks: 5 },
  ];
  const adsets = [
    { level: "adset", name: "New Engagement Ad Set", campaignName: "New Engagement Campaign", spend: 7089, impressions: 20897, results: 161 },
    { level: "adset", name: "New Leads Ad Set - Copy", campaignName: "Pesh | WA | 23/5", spend: 2928, impressions: 18120, results: 22 },
    { level: "adset", name: "Kingdom Ad Set", campaignName: "Kingdom Testing", spend: 1661, impressions: 355, results: 0 },
    // Dead — paused before it ever spent.
    { level: "adset", name: "New Leads Ad Set", campaignName: "Pesh | WA | 23/5", spend: 0, impressions: 0, results: 0 },
  ];
  return {
    id: "aud_polish",
    selectedPlatforms: ["META"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", lookbackDays: 30 } },
    intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 11678, conversions: 183, currency: "PKR" },
        platforms: { META: { spend: 11678, conversions: 183, clicks: 411, impressions: 39372, currency: "PKR" } },
      },
      data: {
        platforms: {
          META: {
            records: [...campaigns, ...adsets],
            byLevel: { campaign: campaigns, adset: adsets },
            byDimension: {},
            byDay: [],
            currency: "PKR",
          },
        },
      },
    },
  };
};

describe("P3 polish findings", () => {
  const { findings } = runDeterministicAudit(polishAudit());
  const byRule = (id) => findings.find((f) => f.ruleId === id);

  it("META-BID-001 flags uncapped automatic bidding at scale", () => {
    const f = byRule("META-BID-001");
    expect(f).toBeDefined();
    expect(f.category).toBe("Bidding & Budget");
    expect(f.evidence.uncappedCampaigns).toBe(2); // the two LOWEST_COST_WITHOUT_CAP campaigns
  });

  it("META-LEARN-001 flags budgets below the learning-phase minimum", () => {
    const f = byRule("META-LEARN-001");
    expect(f).toBeDefined();
    expect(f.evidence.adSetsUnderLearning).toBeGreaterThanOrEqual(2);
  });

  it("META-HYGIENE-001 flags the dead zero-spend ad set", () => {
    const f = byRule("META-HYGIENE-001");
    expect(f).toBeDefined();
    expect(f.severity).toBe("LOW");
    expect(f.evidence.adSet).toBe("New Leads Ad Set");
  });

  it("META-NAMING-001 flags the inconsistent naming convention", () => {
    const f = byRule("META-NAMING-001");
    expect(f).toBeDefined();
    expect(f.evidence.genericCampaigns).toBe(2); // Engagement + Kingdom (Pesh is structured)
  });

  it("META-FLOW-001 flags the campaign losing clicks after the click", () => {
    const f = byRule("META-FLOW-001");
    expect(f).toBeDefined();
    expect(f.evidence.campaign).toBe("Pesh | WA | 23/5"); // 21% vs Engagement 59%
    expect(f.evidence.clickToResultPct).toBeLessThan(f.evidence.benchmarkClickToResultPct);
  });
});
