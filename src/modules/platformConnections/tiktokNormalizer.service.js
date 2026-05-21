// TikTok report items have shape: { dimensions: { campaign_id, ... }, metrics: { spend, ... } }
// This normalizer flattens them into the standard schema the rule engine expects.

const toNum = (v) => (v == null || v === "" || v === "-") ? 0 : parseFloat(v) || 0;

export const normalizeCampaigns = (rawList) =>
  rawList.map((item) => {
    const d = item.dimensions || {};
    const m = item.metrics || {};
    return {
      id: d.campaign_id,
      name: m.campaign_name || d.campaign_id,
      objective: m.objective_type || null,
      budget: toNum(m.campaign_budget),
      budgetMode: m.campaign_budget_mode || null,
      spend: toNum(m.spend),
      impressions: toNum(m.impressions),
      clicks: toNum(m.clicks),
      reach: toNum(m.reach),
      conversions: toNum(m.conversion),
      costPerConversion: toNum(m.cost_per_conversion),
      conversionRate: toNum(m.conversion_rate),
      ctr: toNum(m.ctr),
      cpc: toNum(m.cpc),
      cpm: toNum(m.cpm),
    };
  });

export const normalizeAdGroups = (rawList) =>
  rawList.map((item) => {
    const d = item.dimensions || {};
    const m = item.metrics || {};
    return {
      id: d.adgroup_id,
      campaignId: d.campaign_id,
      name: m.adgroup_name || d.adgroup_id,
      spend: toNum(m.spend),
      impressions: toNum(m.impressions),
      clicks: toNum(m.clicks),
      reach: toNum(m.reach),
      conversions: toNum(m.conversion),
      costPerConversion: toNum(m.cost_per_conversion),
      conversionRate: toNum(m.conversion_rate),
      ctr: toNum(m.ctr),
      cpc: toNum(m.cpc),
      cpm: toNum(m.cpm),
      bid: toNum(m.bid_price),
      optimizationGoal: m.optimization_goal || null,
      placementType: m.placement_type || null,
      budget: toNum(m.budget),
      status: m.status || null,
    };
  });

export const normalizeAds = (rawList) =>
  rawList.map((item) => {
    const d = item.dimensions || {};
    const m = item.metrics || {};
    return {
      id: d.ad_id,
      adGroupId: d.adgroup_id,
      campaignId: d.campaign_id,
      name: m.ad_name || d.ad_id,
      spend: toNum(m.spend),
      impressions: toNum(m.impressions),
      clicks: toNum(m.clicks),
      reach: toNum(m.reach),
      conversions: toNum(m.conversion),
      costPerConversion: toNum(m.cost_per_conversion),
      conversionRate: toNum(m.conversion_rate),
      ctr: toNum(m.ctr),
      cpc: toNum(m.cpc),
      cpm: toNum(m.cpm),
      status: m.status || null,
    };
  });

export const buildTikTokNormalizedDataset = ({ campaignRecords, adGroupRecords, adRecords, currency }) => {
  const totalSpend = campaignRecords.reduce((sum, c) => sum + c.spend, 0);
  const totalImpressions = campaignRecords.reduce((sum, c) => sum + c.impressions, 0);
  const totalClicks = campaignRecords.reduce((sum, c) => sum + c.clicks, 0);
  const totalConversions = campaignRecords.reduce((sum, c) => sum + c.conversions, 0);

  return {
    data: {
      platforms: {
        TIKTOK: {
          byLevel: {
            campaign: campaignRecords,
            adgroup: adGroupRecords,
            ad: adRecords,
          },
        },
      },
    },
    summary: {
      platforms: {
        TIKTOK: {
          campaigns: campaignRecords.length,
          adGroups: adGroupRecords.length,
          ads: adRecords.length,
          spend: totalSpend,
          impressions: totalImpressions,
          clicks: totalClicks,
          conversions: totalConversions,
          currency: currency || null,
        },
      },
      totals: {
        spend: totalSpend,
        impressions: totalImpressions,
        clicks: totalClicks,
        conversions: totalConversions,
      },
    },
  };
};
