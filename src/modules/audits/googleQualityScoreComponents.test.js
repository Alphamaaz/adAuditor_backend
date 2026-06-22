import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * KW-005 enrichment — Quality Score COMPONENTS. The score alone says "low QS";
 * the components (ad relevance / landing page experience / expected CTR) say
 * WHICH lever to pull. The enriched finding must name the dominant Below-Average
 * component so the fix is targeted, not a guess.
 */
const kwAudit = (keywords) => ({
  id: "aud_qs",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 30000, conversions: 200 },
      platforms: { GOOGLE: { spend: 30000, conversions: 200, clicks: 12000, impressions: 400000, currency: "PKR" } },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: keywords,
          byLevel: {
            campaign: [{ level: "campaign", name: "C", status: "ACTIVE", bidStrategy: "MANUAL_CPC", spend: 30000, results: 200, clicks: 12000 }],
            keyword: keywords,
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

const mkKw = (i, qs, comps = {}) => ({
  level: "keyword",
  keywordText: `kw${i}`,
  matchType: "PHRASE",
  status: "ACTIVE",
  qualityScore: qs,
  spend: 1000,
  clicks: 200,
  conversions: 5,
  campaignName: "C",
  adGroupName: "AG",
  adRelevance: comps.adRelevance || "AVERAGE",
  landingPageExperience: comps.landingPageExperience || "AVERAGE",
  expectedCtr: comps.expectedCtr || "AVERAGE",
});

describe("KW-005 — Quality Score component diagnosis", () => {
  it("names landing page experience when it is the dominant Below-Average component", () => {
    const keywords = [
      // 6 healthy (QS 7)
      ...Array.from({ length: 6 }, (_, i) => mkKw(i, 7)),
      // 4 low-QS (QS 3), all dragged by landing page experience
      ...Array.from({ length: 4 }, (_, i) => mkKw(100 + i, 3, { landingPageExperience: "BELOW_AVERAGE" })),
    ];
    const { findings } = runDeterministicAudit(kwAudit(keywords));
    const f = findings.find((x) => x.ruleId === "KW-005");
    expect(f).toBeDefined();
    expect(f.evidence.dominantWeakComponent).toBe("landing page experience");
    expect(f.evidence.componentBelowAverageCounts.landingPageExperience).toBe(4);
    expect(f.title).toMatch(/landing page experience/i);
    expect(f.rootCause).toMatch(/landing page experience/i);
  });

  it("still fires (without a component callout) when component data is absent", () => {
    const keywords = [
      ...Array.from({ length: 6 }, (_, i) => mkKw(i, 7, { adRelevance: null, landingPageExperience: null, expectedCtr: null })),
      ...Array.from({ length: 4 }, (_, i) => mkKw(100 + i, 3, { adRelevance: null, landingPageExperience: null, expectedCtr: null })),
    ];
    const { findings } = runDeterministicAudit(kwAudit(keywords));
    const f = findings.find((x) => x.ruleId === "KW-005");
    expect(f).toBeDefined();
    expect(f.evidence.dominantWeakComponent).toBeNull();
    expect(f.rootCause).toBeNull();
  });
});
