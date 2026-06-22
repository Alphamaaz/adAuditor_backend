import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * Regression: before the fix, the score was `min(weightedScore, 100 -
 * totalPenalty)`. Because one broken campaign now surfaces as many findings
 * (campaign + audience + device + geo + day-of-week), the penalty stacked past
 * 100 and floored an otherwise-healthy, peer-beating account to 0/100. The score
 * must reflect category health with only a capped density penalty.
 */
const financoachLike = () => {
  const campaigns = [
    { level: "campaign", name: "Display | BD | Signals", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: 17560, results: 211, clicks: 6649 },
    { level: "campaign", name: "Display | PK | Signals", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: 9750, results: 8, clicks: 2859 },
  ];
  const audiencePerf = [
    { level: "audience_performance", criterionId: "2488177887755", audienceType: "USER_LIST", audienceLabel: "USER_LIST #2488177887755", campaignName: "Display | BD | Signals", spend: 17560, conversions: 211, clicks: 6649 },
    { level: "audience_performance", criterionId: "2488177887755", audienceType: "USER_LIST", audienceLabel: "USER_LIST #2488177887755", campaignName: "Display | PK | Signals", spend: 7665, conversions: 7, clicks: 2000 },
  ];
  return {
    id: "aud_hs",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 42802, conversions: 351 },
        platforms: { GOOGLE: { spend: 42802, conversions: 351, clicks: 15089, impressions: 433215, currency: "PKR" } },
      },
      data: {
        platforms: {
          GOOGLE: {
            records: campaigns,
            byLevel: {
              campaign: campaigns,
              audience_performance: audiencePerf,
              campaign_device: [
                { level: "campaign_device", campaignName: "Display | PK | Signals", device: "MOBILE", spend: 9000, clicks: 2700, conversions: 8 },
                { level: "campaign_device", campaignName: "Display | PK | Signals", device: "DESKTOP", spend: 750, clicks: 159, conversions: 0 },
              ],
              geo: [
                { level: "geo", country: "Pakistan", countryId: "2586", spend: 9750, clicks: 2859, conversions: 8 },
                { level: "geo", country: "Bangladesh", countryId: "2050", spend: 17560, clicks: 6649, conversions: 211 },
              ],
            },
            byDimension: {
              day_of_week: [
                { dimension: "day_of_week", segment: "Thursday", spend: 8000, clicks: 600, conversions: 30 },
                { dimension: "day_of_week", segment: "Monday", spend: 8000, clicks: 4000, conversions: 100 },
              ],
            },
            byDay: [],
            currency: "PKR",
          },
        },
      },
    },
  };
};

describe("health score", () => {
  it("does not floor a peer-beating account to 0 despite many overlapping findings", () => {
    const { findings, scores } = runDeterministicAudit(financoachLike());
    // Enough findings that the old `100 - totalPenalty` would have gone negative.
    expect(findings.length).toBeGreaterThanOrEqual(4);
    expect(scores.overall).toBeGreaterThan(0);
    expect(scores.overall).toBeGreaterThanOrEqual(40); // mostly-healthy account
    expect(scores.overall).toBeLessThanOrEqual(90); // criticals still pull it down
  });
});
