import { describe, it, expect } from "vitest";
import { normalizeAudiencePerformance } from "./googleNormalizer.service.js";

/**
 * Raw ad_group_audience_view rows (camelCase, money in micros) → normalized
 * audience_performance records with a stable criterionId join key.
 */
describe("normalizeAudiencePerformance", () => {
  const rows = [
    {
      campaign: { id: "111", name: "Display | BD | Signals" },
      adGroup: { id: "211", name: "BD AG" },
      adGroupCriterion: {
        criterionId: "2488177887755",
        type: "USER_LIST",
        userList: { userList: "customers/1/userLists/2488177887755" },
      },
      metrics: {
        impressions: "100831",
        clicks: "6649",
        costMicros: "17560000000",
        conversions: 211,
        conversionsValue: 0,
        ctr: 0.0659,
        averageCpc: "2640000",
        costPerConversion: "83000000",
      },
    },
    // Empty row (no spend, no impressions) — must be dropped.
    {
      campaign: { id: "111", name: "Display | BD | Signals" },
      adGroupCriterion: { criterionId: "999", type: "USER_INTEREST" },
      metrics: { impressions: "0", clicks: "0", costMicros: "0", conversions: 0 },
    },
  ];

  it("maps identity + metrics and derives CPA from micros", () => {
    const out = normalizeAudiencePerformance(rows);
    expect(out).toHaveLength(1); // empty row dropped
    const r = out[0];
    expect(r.level).toBe("audience_performance");
    expect(r.criterionId).toBe("2488177887755");
    expect(r.audienceType).toBe("USER_LIST");
    expect(r.campaignName).toBe("Display | BD | Signals");
    expect(r.spend).toBeCloseTo(17560, 0);
    expect(r.conversions).toBe(211);
    expect(r.cpa).toBeCloseTo(83.2, 0);
    expect(r.audienceLabel).toBe("USER_LIST #2488177887755");
  });

  it("returns [] for empty input", () => {
    expect(normalizeAudiencePerformance([])).toEqual([]);
    expect(normalizeAudiencePerformance()).toEqual([]);
  });

  it("uses the resolved display name when the resource lookup found one", () => {
    const out = normalizeAudiencePerformance(rows, {
      "customers/1/userLists/2488177887755": "Loan Seekers - Search",
    });
    expect(out[0].audienceName).toBe("Loan Seekers - Search");
    expect(out[0].audienceLabel).toBe("Loan Seekers - Search"); // name, not "#2488…"
  });

  it("resolves a custom-audience resource name", () => {
    const customRow = [{
      campaign: { id: "111", name: "Display | PK | Signals" },
      adGroupCriterion: {
        criterionId: "777",
        type: "CUSTOM_AUDIENCE",
        customAudience: { customAudience: "customers/1/customAudiences/777" },
      },
      metrics: { impressions: "5000", clicks: "120", costMicros: "3000000000", conversions: 2 },
    }];
    const out = normalizeAudiencePerformance(customRow, {
      "customers/1/customAudiences/777": "Site Visitors 30d",
    });
    expect(out[0].audienceName).toBe("Site Visitors 30d");
    expect(out[0].audienceLabel).toBe("Site Visitors 30d");
  });

  it("falls back to the type + id label when no name resolves", () => {
    const out = normalizeAudiencePerformance(rows, {}); // empty name map
    expect(out[0].audienceName).toBeNull();
    expect(out[0].audienceLabel).toBe("USER_LIST #2488177887755");
  });
});
