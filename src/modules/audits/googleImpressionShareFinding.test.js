import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { parseImpactDollars } from "../../lib/findings/priority.js";

/**
 * GOOGLE-IS-001 / GOOGLE-IS-002 — Search Impression Share.
 * The biggest signal a segment slice can't see: the demand a campaign MISSES.
 *   • lost to BUDGET on a converting campaign → upside (raise budget), expressed
 *     in incremental conversions, never a recoverable-dollar figure.
 *   • lost to RANK → bids/Quality Score gap, not a budget one.
 * Display/Video/PMax (no searchImpressionShare) must be skipped.
 */
const isAudit = (campaigns, summary = { spend: 50000, conversions: 400, clicks: 18000, impressions: 600000, currency: "PKR" }) => ({
  id: "aud_is",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: summary.spend, conversions: summary.conversions },
      platforms: { GOOGLE: summary },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: campaigns,
          byLevel: { campaign: campaigns },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("GOOGLE-IS-001 — budget-capped impression share", () => {
  it("flags a profitable campaign losing impressions to budget (as upside, no recoverable dollars)", () => {
    // baseline CPA = 50000/400 = 125. Campaign converts at 100 (efficient),
    // loses 30% of impressions to budget on 40% IS.
    const { findings } = runDeterministicAudit(
      isAudit([
        {
          level: "campaign", name: "Search | Brand", status: "ACTIVE", bidStrategy: "TARGET_CPA",
          spend: 20000, results: 200, impressions: 120000, clicks: 9000,
          searchImpressionShare: 0.4, searchBudgetLostIS: 0.3, searchRankLostIS: 0.1,
        },
      ])
    );
    const is = findings.find((f) => f.ruleId === "GOOGLE-IS-001");
    expect(is).toBeDefined();
    expect(is.severity).toBe("HIGH"); // ≥20% budget-lost
    expect(is.evidence.opportunity).toBe(true);
    expect(is.evidence.budgetLostSharePercent).toBe(30);
    // 200 * (0.30 / 0.40) = 150 incremental conversions
    expect(is.evidence.estimatedAdditionalConversions).toBe(150);
    // Upside, not recovered waste — must carry no dollar figure.
    expect(parseImpactDollars(is.estimatedImpact)).toBe(0);
  });

  it("does NOT recommend scaling a campaign that is losing money", () => {
    // Same budget loss, but CPA 250 ≫ baseline 125 — pouring budget in is wrong.
    const { findings } = runDeterministicAudit(
      isAudit([
        {
          level: "campaign", name: "Search | Generic", status: "ACTIVE", bidStrategy: "TARGET_CPA",
          spend: 20000, results: 80, impressions: 120000, clicks: 9000,
          searchImpressionShare: 0.4, searchBudgetLostIS: 0.3, searchRankLostIS: 0.1,
        },
      ])
    );
    expect(findings.find((f) => f.ruleId === "GOOGLE-IS-001")).toBeUndefined();
  });

  it("skips Display/PMax campaigns that report no impression share", () => {
    const { findings } = runDeterministicAudit(
      isAudit([
        {
          level: "campaign", name: "Display | Prospecting", status: "ACTIVE", bidStrategy: "TARGET_CPA",
          spend: 20000, results: 200, impressions: 500000, clicks: 9000,
          searchImpressionShare: null, searchBudgetLostIS: null, searchRankLostIS: null,
        },
      ])
    );
    expect(findings.find((f) => f.ruleId === "GOOGLE-IS-001")).toBeUndefined();
    expect(findings.find((f) => f.ruleId === "GOOGLE-IS-002")).toBeUndefined();
  });
});

describe("GOOGLE-IS-002 — rank-capped impression share", () => {
  it("flags a campaign losing impressions to Ad Rank (bid / Quality Score gap)", () => {
    const { findings } = runDeterministicAudit(
      isAudit([
        {
          level: "campaign", name: "Search | Competitor", status: "ACTIVE", bidStrategy: "TARGET_CPA",
          spend: 15000, results: 100, impressions: 80000, clicks: 5000,
          searchImpressionShare: 0.3, searchBudgetLostIS: 0.05, searchRankLostIS: 0.45,
        },
      ])
    );
    const rank = findings.find((f) => f.ruleId === "GOOGLE-IS-002");
    expect(rank).toBeDefined();
    expect(rank.severity).toBe("MEDIUM");
    expect(rank.category).toBe("Quality Score & Relevance");
    expect(rank.evidence.rankLostSharePercent).toBe(45);
    expect(parseImpactDollars(rank.estimatedImpact)).toBe(0);
  });

  it("does not fire when impression share is healthy", () => {
    const { findings } = runDeterministicAudit(
      isAudit([
        {
          level: "campaign", name: "Search | Brand", status: "ACTIVE", bidStrategy: "TARGET_CPA",
          spend: 20000, results: 200, impressions: 120000, clicks: 9000,
          searchImpressionShare: 0.92, searchBudgetLostIS: 0.03, searchRankLostIS: 0.05,
        },
      ])
    );
    expect(findings.find((f) => f.ruleId === "GOOGLE-IS-001")).toBeUndefined();
    expect(findings.find((f) => f.ruleId === "GOOGLE-IS-002")).toBeUndefined();
  });
});
