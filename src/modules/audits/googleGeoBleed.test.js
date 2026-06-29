import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * GOOGLE-GEO-002 — per-campaign geo bleed. A campaign built for one market that
 * also delivers in another (a missing location exclusion) leaks budget the
 * country-level rule can't isolate. Mirrors the Claude-MCP benchmark finding:
 * the old BD campaign serving in Pakistan at zero conversions.
 */
const audit = (geo) => ({
  id: "aud_geo_bleed",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 90000, conversions: 600, currency: "PKR" },
      platforms: { GOOGLE: { spend: 90000, conversions: 600, clicks: 9000, impressions: 200000, currency: "PKR" } },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [],
          byLevel: {
            campaign: [{ level: "campaign", name: "Display | BD | 8/4 (OLD PROJ)", spend: 29352, conversions: 192, impressions: 100000, clicks: 7125 }],
            geo,
          },
          byDimension: {},
          byDay: [],
        },
      },
    },
  },
});

const bleed = (findings) => findings.find((f) => f.ruleId === "GOOGLE-GEO-002");

describe("GOOGLE-GEO-002 per-campaign geo bleed", () => {
  it("flags a single-market campaign bleeding into a foreign country at zero conversions", () => {
    const { findings } = runDeterministicAudit(
      audit([
        { level: "geo", campaignName: "Display | BD | 8/4 (OLD PROJ)", country: "Bangladesh", spend: 26929, clicks: 6649, conversions: 192 },
        { level: "geo", campaignName: "Display | BD | 8/4 (OLD PROJ)", country: "Pakistan", spend: 2423, clicks: 476, conversions: 0 },
      ])
    );
    const f = bleed(findings);
    expect(f).toBeDefined();
    expect(f.evidence.homeCountry).toBe("Bangladesh");
    expect(f.evidence.country).toBe("Pakistan");
    expect(f.evidence.reason).toBe("zero_conversions");
    expect(f.evidence.spend).toBe(2423);
  });

  it("does NOT flag a genuinely multi-market campaign (spread spend, no dominant home)", () => {
    const { findings } = runDeterministicAudit(
      audit([
        { level: "geo", campaignName: "Display | BD | 8/4 (OLD PROJ)", country: "India", spend: 5000, clicks: 1000, conversions: 40 },
        { level: "geo", campaignName: "Display | BD | 8/4 (OLD PROJ)", country: "UAE", spend: 4500, clicks: 900, conversions: 35 },
      ])
    );
    expect(bleed(findings)).toBeUndefined();
  });

  it("does NOT flag a foreign country that converts fine (no bleed)", () => {
    const { findings } = runDeterministicAudit(
      audit([
        { level: "geo", campaignName: "Display | BD | 8/4 (OLD PROJ)", country: "Bangladesh", spend: 26929, clicks: 6649, conversions: 192 },
        // Material spend in PK but converting at home-comparable CPA → not a leak.
        { level: "geo", campaignName: "Display | BD | 8/4 (OLD PROJ)", country: "Pakistan", spend: 2000, clicks: 400, conversions: 13 },
      ])
    );
    expect(bleed(findings)).toBeUndefined();
  });
});
