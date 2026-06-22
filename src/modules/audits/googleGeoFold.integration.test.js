import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * End-to-end: the financoach defect from ad-audit-report (16) — GOOGLE-GEO
 * (Pakistan) and CAMP-CPA ("Display | PK …") reported the SAME PKR ~11.9k spend
 * pool twice, double-stating it in the findings table, money map, and action
 * plan. After the fix the audit must surface that pool ONCE (the campaign
 * finding), with the geo leak folded in as the root-cause driver.
 */
const financoachGeoAudit = () => {
  const campaigns = [
    { level: "campaign", name: "Display | BD | Signals | Tightened | 6/6", status: "ACTIVE", bidStrategy: "TARGET_CPA", objective: "DISPLAY", campaignId: "1", spend: 17560, results: 211, clicks: 6649 },
    { level: "campaign", name: "Display | PK | Signals | Tightened | 6/8", status: "ACTIVE", bidStrategy: "TARGET_CPA", objective: "DISPLAY", campaignId: "2", spend: 16090, results: 30, clicks: 5882 },
  ];
  const geo = [
    { level: "geo", country: "Pakistan", countryId: "2586", locationType: "AREA_OF_INTEREST", spend: 16090, clicks: 5882, conversions: 30 },
    { level: "geo", country: "Bangladesh", countryId: "2050", locationType: "LOCATION_OF_PRESENCE", spend: 17560, clicks: 6649, conversions: 211 },
  ];
  return {
    id: "aud_geo_fold",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 33650, conversions: 241 },
        platforms: { GOOGLE: { spend: 33650, conversions: 241, clicks: 12531, impressions: 400000, currency: "PKR" } },
      },
      data: {
        platforms: {
          GOOGLE: {
            records: campaigns,
            byLevel: { campaign: campaigns, geo },
            byDimension: {},
            byDay: [],
            currency: "PKR",
          },
        },
      },
    },
  };
};

describe("geo↔campaign collapse (end-to-end)", () => {
  it("surfaces the PK spend pool once and folds the geo leak in as the cause", () => {
    const { findings } = runDeterministicAudit(financoachGeoAudit());

    const camp = findings.find((f) => f.ruleId === "CAMP-CPA-001");
    const geo = findings.find((f) => f.ruleId === "GOOGLE-GEO-001");

    // Both rules still FIRE internally, but the geo duplicate is collapsed away.
    expect(camp).toBeDefined();
    expect(geo).toBeUndefined();

    // The campaign finding now carries the geo root-cause + location fix.
    expect(camp.evidence.geoCauseFolded).toBe("Pakistan");
    expect(camp.detail).toMatch(/Pakistan/);
    expect(camp.fixSteps.some((s) => /presence|location/i.test(s))).toBe(true);
  });
});
