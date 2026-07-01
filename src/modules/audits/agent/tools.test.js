import { describe, it, expect } from "vitest";
import { createDeepAuditTools, TOOL_SCHEMAS, runTool } from "./tools.js";

/**
 * The bundle mirrors the live MCP audit: Essa Trader (current, messaging
 * objective) vs Umeed Marketing (peer). Essa and Umeed pay ~the same CPM but
 * Essa's CTR is ~2.4× worse — so a CPR decomposition vs the peer must land on
 * CTR as the dominant driver, reproducing "I said CPM, then the data said CTR"
 * deterministically (no LLM).
 */
const essaAudit = {
  id: "aud_essa",
  adAccountId: "988668883657827",
  adAccount: { name: "Essa Trader" },
  selectedPlatforms: ["META"],
  healthScore: 62,
  completedAt: "2026-06-03T00:00:00Z",
  dataSource: "OAUTH",
  businessProfileSnapshot: {
    sectionA: { businessType: "Lead Gen", targetCpa: 20 },
  },
  normalizedDataset: {
    summary: {
      totals: { spend: 2019, impressions: 51000, clicks: 2020, conversions: 64 },
    },
    data: {
      platforms: {
        META: {
          byDimension: {
            age: [
              { dimension: "age", segment: "25-34", spend: 729, clicks: 500, impressions: 20000, conversions: 25, results: 25 },
              { dimension: "age", segment: "45-54", spend: 206, clicks: 180, impressions: 12000, conversions: 0, results: 0 },
            ],
          },
        },
      },
    },
  },
  ruleFindings: [
    { ruleId: "CRE-003", platform: "META", severity: "HIGH", category: "Creative Performance", title: "Below-average ranked ads", estimatedImpact: "$1,200 in spend on below-average ranked ads" },
    { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", category: "Audience Strategy", title: "Age 45-54 waste", estimatedImpact: "$206 wasted on the 45-54 bracket" },
  ],
};

// Umeed Marketing as a stored memory summary: same platform + business type,
// same spend band, ~equal CPM, far higher CTR.
const umeedPrior = {
  auditId: "aud_umeed",
  adAccountId: "1436038968289644",
  adAccountName: "Umeed Marketing",
  selectedPlatforms: ["META"],
  businessType: "Lead Gen",
  completedAt: "2026-06-01T00:00:00Z",
  spend: 2000,
  impressions: 50000,
  clicks: 4800,
  conversions: 150,
  healthScore: 80,
  criticalRuleIds: [],
};

const googleDeadKeywordAudit = {
  id: "aud_google_dead_keywords",
  selectedPlatforms: ["GOOGLE"],
  healthScore: 76,
  dataSource: "OAUTH",
  businessProfileSnapshot: {
    sectionA: { businessType: "eCommerce", targetCpa: 160 },
  },
  normalizedDataset: {
    summary: {
      totals: { spend: 43470, impressions: 100000, clicks: 3000, conversions: 270 },
      platforms: {
        GOOGLE: {
          spend: 43470,
          impressions: 100000,
          clicks: 3000,
          conversions: 270,
          currency: "PKR",
        },
      },
    },
    data: {
      platforms: {
        GOOGLE: {
          byLevel: {
            campaign: [
              { level: "campaign", name: "PMax", objective: "PERFORMANCE_MAX", spend: 35000, impressions: 70000, clicks: 2100, conversions: 240 },
              { level: "campaign", name: "Search", objective: "SEARCH", spend: 8470, impressions: 30000, clicks: 900, conversions: 30 },
            ],
            keyword: [
              { level: "keyword", keyword: "blue widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "red widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "green widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "yellow widgets", status: "ACTIVE", impressions: 0, spend: 0 },
              { level: "keyword", keyword: "white widgets", status: "ACTIVE", impressions: 0, spend: 0 },
            ],
          },
        },
      },
    },
  },
  ruleFindings: [
    {
      ruleId: "KW-010",
      platform: "GOOGLE",
      severity: "MEDIUM",
      category: "Keyword Strategy",
      title: "Many active Google keywords are getting zero impressions",
      estimatedImpact: "Zero-impression active keywords inflate account clutter.",
    },
  ],
};

const tools = () => createDeepAuditTools({ audit: essaAudit, priorAudits: [umeedPrior] });

describe("createDeepAuditTools", () => {
  it("requires an audit", () => {
    expect(() => createDeepAuditTools({})).toThrow();
  });

  describe("decomposeKpi", () => {
    it("names CTR as the dominant CPR driver vs the peer (Essa-vs-Umeed)", () => {
      const out = tools().decomposeKpi({ kpi: "CPR" });
      expect(out.base.cpm).toBeCloseTo(39.59, 1);
      expect(out.referenceSource).toBe("peer:Umeed Marketing");
      expect(out.decomposition.hasReference).toBe(true);
      expect(out.comparison.available).toBe(true);
      expect(out.decomposition.dominantDriver).toBe("CTR");
      // CTR explains the overwhelming majority of the gap; CPM almost none.
      const ctr = out.decomposition.drivers.find((d) => d.name === "CTR");
      const cpm = out.decomposition.drivers.find((d) => d.name === "CPM");
      expect(ctr.contributionPct).toBeGreaterThan(80);
      expect(cpm.contributionPct).toBeLessThan(10);
    });

    it("reports the benchmark-relative diagnosis alongside (CTR healthy vs the low industry floor)", () => {
      const out = tools().decomposeKpi({ kpi: "CPA" });
      // vs the Lead Gen benchmark (good 1.6% / warning 0.8%), Essa's 3.96% CTR is fine — so
      // the benchmark diagnosis blames conversion rate, even though vs the peer
      // CTR is the lever. Both references are honest; this locks the units.
      expect(out.diagnosis.dominantDriver).toBe("conversion_rate");
    });

    it("falls back to no-reference attribution when no peer exists", () => {
      const out = createDeepAuditTools({ audit: essaAudit, priorAudits: [] }).decomposeKpi({ kpi: "CPR" });
      expect(out.referenceSource).toBe("none");
      expect(out.decomposition.hasReference).toBe(false);
      expect(out.comparison.available).toBe(false);
      expect(out.decomposition.dominantDriver).toBeTruthy();
    });
  });

  describe("analyzeSegments", () => {
    it("flags the 45-54 bracket as the headline waste (the $206 case)", () => {
      const out = tools().analyzeSegments();
      expect(out.available).toBe(true);
      expect(out.headline.dimension).toBe("age");
      expect(out.headline.worst.segment).toBe("45-54");
      expect(out.headline.worst.wastedSpend).toBe(206);
      expect(out.headline.worst.wastedSpendFormatted).toBe("$206");
      expect(out.headline.worst.reason).toBe("zero_conversions");
      expect(out.headline.worst.significant).toBe(true);
    });

    it("reports unavailable when no breakdown data exists", () => {
      const bare = { ...essaAudit, normalizedDataset: { summary: { totals: {} }, data: { platforms: { META: {} } } } };
      const out = createDeepAuditTools({ audit: bare }).analyzeSegments();
      expect(out.available).toBe(false);
      expect(out.reason).toBe("no_breakdown_data");
    });
  });

  describe("analyzeCampaignTypes", () => {
    it("explains where spend comes from when active keywords have zero impressions", () => {
      const out = createDeepAuditTools({ audit: googleDeadKeywordAudit }).analyzeCampaignTypes();
      expect(out.available).toBe(true);
      expect(out.currency).toBe("PKR");
      expect(out.totalSpendFormatted).toBe("PKR 43,470");
      expect(out.types[0]).toMatchObject({
        channelType: "PERFORMANCE_MAX",
        spendFormatted: "PKR 35,000",
        cpaFormatted: "PKR 146",
      });
      expect(out.keywordCoverage.zeroImpressionSharePct).toBe(100);
      expect(out.deadKeywordSignal).toMatchObject({
        available: true,
        zeroImpressionKeywords: 5,
        activeKeywordsTotal: 5,
        topSpendChannelType: "PERFORMANCE_MAX",
        topSpendFormatted: "PKR 35,000",
      });
    });
  });

  describe("getPeerComparison", () => {
    it("surfaces the CTR gap vs Umeed with high confidence", () => {
      const out = tools().getPeerComparison();
      expect(out.available).toBe(true);
      expect(out.peer.adAccountName).toBe("Umeed Marketing");
      expect(out.strongestGap.metric).toBe("CTR");
      expect(out.confidence).toBe("high");
    });

    it("reports unavailable with no eligible peer", () => {
      const out = createDeepAuditTools({ audit: essaAudit, priorAudits: [] }).getPeerComparison();
      expect(out.available).toBe(false);
    });
  });

  describe("getMemoryDelta", () => {
    it("reports unavailable when there is no prior audit of the same account", () => {
      const out = tools().getMemoryDelta();
      expect(out.available).toBe(false);
      expect(out.reason).toBe("no_prior_audit");
    });

    it("computes deltas vs a prior audit of the same account", () => {
      const priorEssa = { ...umeedPrior, auditId: "aud_essa_prev", adAccountId: essaAudit.adAccountId, adAccountName: "Essa Trader", spend: 1800, impressions: 48000, clicks: 1900, conversions: 50, healthScore: 55 };
      const out = createDeepAuditTools({ audit: essaAudit, priorAudits: [priorEssa] }).getMemoryDelta();
      expect(out.available).toBe(true);
      expect(out.healthScoreDelta).toBeCloseTo(7, 1);
    });
  });

  describe("checkSignificance", () => {
    it("passes CPR at 64 results, fails CTR at 500 impressions", () => {
      expect(tools().checkSignificance({ metric: "cpr", denominator: 64 }).significant).toBe(true);
      expect(tools().checkSignificance({ metric: "ctr", denominator: 500 }).significant).toBe(false);
    });
  });

  describe("getBenchmark", () => {
    it("returns the CTR band for the account's platform + business type", () => {
      const out = tools().getBenchmark({ metric: "ctr" });
      expect(out.available).toBe(true);
      expect(out.platform).toBe("META");
      // Calibrated 2026-07-01 to 2025 Meta median CTR (~2.19%): Lead Gen good = 1.6.
      expect(out.band.good).toBe(1.6);
    });
  });

  describe("listFindings", () => {
    it("filters by minimum dollar impact and ranks by impact", () => {
      const big = tools().listFindings({ minImpact: 500 });
      expect(big).toHaveLength(1);
      expect(big[0].ruleId).toBe("CRE-003");

      const all = tools().listFindings({ minImpact: 0 });
      expect(all.map((f) => f.ruleId)).toEqual(["CRE-003", "SEG-WASTE-001"]);
      expect(all[0].estimatedImpactDollars).toBe(1200);
    });
  });

  describe("getEvidencePacket", () => {
    it("returns a curated packet with no raw rows and peer comparison", () => {
      const packet = tools().getEvidencePacket();
      expect(packet.contextLimits.rawRowsIncluded).toBe(false);
      expect(packet.topFindings).toHaveLength(2);
      expect(Array.isArray(packet.verifiedNumbers)).toBe(true);
      expect(packet.comparison.peer).toBeTruthy();
    });
  });
});

describe("TOOL_SCHEMAS + runTool", () => {
  it("exposes one schema per tool method", () => {
    const t = tools();
    const schemaNames = TOOL_SCHEMAS.map((s) => s.name).sort();
    const toolNames = Object.keys(t).sort();
    expect(schemaNames).toEqual(toolNames);
  });

  it("dispatches a known tool", () => {
    const out = runTool(tools(), "decomposeKpi", { kpi: "CPR" });
    expect(out.decomposition.dominantDriver).toBe("CTR");
  });

  it("returns an error for an unknown tool instead of throwing", () => {
    expect(runTool(tools(), "nope", {})).toEqual({ error: "unknown_tool:nope" });
  });
});
