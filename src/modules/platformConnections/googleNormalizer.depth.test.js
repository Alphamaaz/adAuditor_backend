import { describe, it, expect } from "vitest";
import {
  normalizeCampaignDevicePerformance,
  normalizeLandingPagePerformance,
  normalizeGeoPerformance,
  normalizeCampaigns,
  normalizeConversionActions,
  normalizeAds,
  normalizeCampaignAssets,
  normalizeKeywords,
} from "./googleNormalizer.service.js";

describe("normalizeCampaigns — Smart-bidding targets", () => {
  it("reads Target CPA (micros) and Target ROAS off the campaign", () => {
    const out = normalizeCampaigns([
      {
        campaign: {
          id: "1", name: "Search | Leads", status: "ENABLED", biddingStrategyType: "TARGET_CPA",
          targetCpa: { targetCpaMicros: "100000000" },
          targetRoas: { targetRoas: 4 },
        },
        metrics: { costMicros: "20000000000", conversions: 100 },
      },
    ]);
    expect(out[0].targetCpa).toBeCloseTo(100, 0);
    expect(out[0].targetRoas).toBe(4);
  });

  it("falls back to the target on Maximize Conversions", () => {
    const out = normalizeCampaigns([
      {
        campaign: { id: "2", name: "Max+tCPA", status: "ENABLED", biddingStrategyType: "MAXIMIZE_CONVERSIONS", maximizeConversions: { targetCpaMicros: "80000000" } },
        metrics: { costMicros: "5000000000" },
      },
    ]);
    expect(out[0].targetCpa).toBeCloseTo(80, 0);
  });
});

describe("normalizeKeywords — Quality Score components", () => {
  it("maps the three QS component buckets", () => {
    const out = normalizeKeywords([
      {
        adGroupCriterion: {
          criterionId: "9", keyword: { text: "kw", matchType: "PHRASE" }, status: "ENABLED",
          qualityInfo: { qualityScore: 3, creativeQualityScore: "AVERAGE", postClickQualityScore: "BELOW_AVERAGE", searchPredictedCtr: "ABOVE_AVERAGE" },
        },
        metrics: { costMicros: "1000000000" },
      },
    ]);
    expect(out[0]).toMatchObject({
      qualityScore: 3,
      adRelevance: "AVERAGE",
      landingPageExperience: "BELOW_AVERAGE",
      expectedCtr: "ABOVE_AVERAGE",
    });
  });
});

describe("normalizeAds — Ad Strength", () => {
  it("maps ad_strength off the ad row", () => {
    const out = normalizeAds([
      {
        adGroupAd: { ad: { id: "9", name: "RSA A", type: "RESPONSIVE_SEARCH_AD" }, adStrength: "POOR", status: "ENABLED" },
        adGroup: { id: "5", name: "Brand" },
        campaign: { id: "1", name: "Search | Brand" },
        metrics: { costMicros: "4000000000", impressions: "12000", clicks: "300", conversions: 5 },
      },
    ]);
    expect(out[0]).toMatchObject({ level: "ad", adStrength: "POOR", adGroupName: "Brand", campaignName: "Search | Brand" });
  });
});

describe("normalizeCampaignAssets", () => {
  it("maps campaign × extension link rows", () => {
    const out = normalizeCampaignAssets([
      { campaign: { id: "1", name: "Search | Brand", advertisingChannelType: "SEARCH" }, campaignAsset: { fieldType: "SITELINK", status: "ENABLED" } },
    ]);
    expect(out[0]).toMatchObject({
      level: "campaign_asset", campaignId: "1", channelType: "SEARCH",
      fieldType: "SITELINK", status: "ACTIVE",
    });
  });
});

describe("normalizeCampaigns — Search Impression Share fields", () => {
  it("maps the IS metric fields off a Search campaign row", () => {
    const out = normalizeCampaigns([
      {
        campaign: { id: "1", name: "Search | Brand", status: "ENABLED", biddingStrategyType: "TARGET_CPA" },
        metrics: {
          costMicros: "20000000000",
          impressions: "120000",
          clicks: "9000",
          conversions: 200,
          searchImpressionShare: 0.4,
          searchBudgetLostImpressionShare: 0.3,
          searchRankLostImpressionShare: 0.1,
          searchTopImpressionShare: 0.55,
          searchAbsoluteTopImpressionShare: 0.2,
        },
      },
    ]);
    expect(out[0]).toMatchObject({
      searchImpressionShare: 0.4,
      searchBudgetLostIS: 0.3,
      searchRankLostIS: 0.1,
      searchTopIS: 0.55,
      searchAbsTopIS: 0.2,
    });
  });

  it("leaves IS fields null when absent (Display/Video/PMax)", () => {
    const out = normalizeCampaigns([
      { campaign: { id: "2", name: "Display | Prospecting", status: "ENABLED" }, metrics: { costMicros: "5000000000" } },
    ]);
    expect(out[0].searchImpressionShare).toBeNull();
    expect(out[0].searchBudgetLostIS).toBeNull();
    expect(out[0].searchRankLostIS).toBeNull();
  });
});

describe("normalizeConversionActions", () => {
  it("maps config fields and coerces primaryForGoal to a boolean", () => {
    const out = normalizeConversionActions([
      {
        conversionAction: {
          id: "777", name: "Purchase", status: "ENABLED", type: "WEBPAGE",
          category: "PURCHASE", primaryForGoal: true, countingType: "ONE_PER_CLICK",
        },
      },
      {
        conversionAction: { id: "888", name: "Page view", status: "ENABLED", category: "PAGE_VIEW" },
      },
    ]);
    expect(out[0]).toMatchObject({
      level: "conversion_action", id: "777", status: "ACTIVE",
      category: "PURCHASE", primaryForGoal: true, countingType: "ONE_PER_CLICK",
    });
    // Missing primaryForGoal must normalize to false, not undefined.
    expect(out[1].primaryForGoal).toBe(false);
  });
});

describe("normalizeCampaignDevicePerformance", () => {
  it("maps per-campaign device rows with micros→spend", () => {
    const out = normalizeCampaignDevicePerformance([
      {
        campaign: { id: "1", name: "Display | IND | Signals" },
        segments: { device: "DESKTOP" },
        metrics: { costMicros: "173000000", impressions: "2337", clicks: "47", conversions: 0 },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      level: "campaign_device",
      campaignName: "Display | IND | Signals",
      device: "DESKTOP",
      clicks: 47,
      conversions: 0,
      cpa: null,
    });
    expect(out[0].spend).toBeCloseTo(173, 0);
  });
});

describe("normalizeLandingPagePerformance", () => {
  it("derives CVR from clicks and conversions", () => {
    const out = normalizeLandingPagePerformance([
      {
        landingPageView: { unexpandedFinalUrl: "http://ads.financoach.com/" },
        metrics: { costMicros: "17560000000", impressions: "100000", clicks: "6649", conversions: 211 },
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("http://ads.financoach.com/");
    expect(out[0].cvr).toBeCloseTo(211 / 6649, 4);
    expect(out[0].cpa).toBeCloseTo(83.2, 0);
  });

  it("drops rows with no url", () => {
    const out = normalizeLandingPagePerformance([
      { landingPageView: {}, metrics: { clicks: "10", conversions: 1, costMicros: "5000000" } },
    ]);
    expect(out).toEqual([]);
  });
});

describe("normalizeGeoPerformance", () => {
  it("resolves country id to name and falls back to raw id", () => {
    const rows = [
      {
        campaign: { name: "Display | PK | Signals" },
        geographicView: { countryCriterionId: "2586", locationType: "AREA_OF_INTEREST" },
        metrics: { costMicros: "3000000000", impressions: "9000", clicks: "800", conversions: 0 },
      },
      {
        campaign: { name: "Display | BD | Signals" },
        geographicView: { countryCriterionId: "2050", locationType: "LOCATION_OF_PRESENCE" },
        metrics: { costMicros: "1000000000", impressions: "5000", clicks: "300", conversions: 12 },
      },
    ];
    const out = normalizeGeoPerformance(rows, { "2586": { name: "Pakistan", countryCode: "PK" } });
    expect(out).toHaveLength(2);
    expect(out[0].country).toBe("Pakistan");
    expect(out[0].countryCode).toBe("PK");
    expect(out[1].country).toBe("geo 2050"); // unresolved → raw id fallback
  });
});
