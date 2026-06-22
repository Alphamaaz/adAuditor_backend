/**
 * Normalizes raw Google Ads API (GAQL) responses into the same normalized schema
 * used by the CSV normalizers and the Meta normalizer. This ensures the rule engine
 * works identically regardless of data source.
 *
 * Google Ads API quirks:
 * - All money values are in micros (1/1,000,000 of the account currency).
 * - GAQL returns camelCase field paths nested under resource objects.
 * - Status enums: ENABLED, PAUSED, REMOVED, UNKNOWN.
 */

const parseNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const n = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// Google Ads stores cost/CPC/CPM in micros — divide by 1,000,000
const microsToDecimal = (micros) => {
  const n = parseNumber(micros);
  return n !== null ? n / 1_000_000 : null;
};

const STATUS_MAP = {
  ENABLED: "ACTIVE",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
};

const mapStatus = (raw) => STATUS_MAP[raw] || raw || null;

// ── Campaign-level ──────────────────────────────────────────────────────────

export const normalizeCampaigns = (rows) =>
  rows.map((row) => {
    const costMicros = microsToDecimal(row.metrics?.costMicros);
    const allConversionsValue = parseNumber(row.metrics?.allConversionsValue);
    const conversions = parseNumber(row.metrics?.conversions);

    return {
      level: "campaign",
      name: row.campaign?.name || null,
      campaignId: row.campaign?.id || null,
      status: mapStatus(row.campaign?.status),
      objective: row.campaign?.advertisingChannelType || null,
      bidStrategy: row.campaign?.biddingStrategyType || null,
      // Smart-bidding targets set on the campaign (null for portfolio strategies,
      // whose targets live on a shared bidding_strategy resource). Powers
      // GOOGLE-BID-002 (target vs. actual). Prefer the explicit Target-CPA/ROAS
      // strategy field, then the optional target on Maximize Conversions/Value.
      targetCpa:
        microsToDecimal(row.campaign?.targetCpa?.targetCpaMicros) ??
        microsToDecimal(row.campaign?.maximizeConversions?.targetCpaMicros),
      targetRoas:
        parseNumber(row.campaign?.targetRoas?.targetRoas) ??
        parseNumber(row.campaign?.maximizeConversionValue?.targetRoas),
      budget: microsToDecimal(row.campaignBudget?.amountMicros),
      spend: costMicros,
      impressions: parseNumber(row.metrics?.impressions),
      clicks: parseNumber(row.metrics?.clicks),
      ctr: parseNumber(row.metrics?.ctr),
      cpc: microsToDecimal(row.metrics?.averageCpc),
      cpm: microsToDecimal(row.metrics?.averageCpm),
      results: conversions,
      cpa: microsToDecimal(row.metrics?.costPerConversion),
      roas:
        allConversionsValue !== null && costMicros
          ? allConversionsValue / costMicros
          : null,
      viewThroughConversions: parseNumber(row.metrics?.viewThroughConversions),
      // Search Impression Share metrics (fractions 0–1). Only populated for
      // Search/Shopping campaigns; null on Display/Video/PMax. Powers GOOGLE-IS-001.
      searchImpressionShare: parseNumber(row.metrics?.searchImpressionShare),
      searchBudgetLostIS: parseNumber(row.metrics?.searchBudgetLostImpressionShare),
      searchRankLostIS: parseNumber(row.metrics?.searchRankLostImpressionShare),
      searchTopIS: parseNumber(row.metrics?.searchTopImpressionShare),
      searchAbsTopIS: parseNumber(row.metrics?.searchAbsoluteTopImpressionShare),
      reach: null,
      frequency: null,
      dateStart: null,
      dateEnd: null,
    };
  });

// ── Campaign assets (ad extensions) ──────────────────────────────────────────

/**
 * Normalize campaign-asset (extension) rows. One row per campaign × extension
 * link. fieldType is the extension kind (SITELINK, CALLOUT, STRUCTURED_SNIPPET,
 * …). Powers GOOGLE-EXT-001 (missing extension coverage per campaign).
 */
export const normalizeCampaignAssets = (rows = []) =>
  (rows || []).map((row) => ({
    level: "campaign_asset",
    campaignId: row.campaign?.id || null,
    campaignName: row.campaign?.name || null,
    channelType: row.campaign?.advertisingChannelType || null,
    fieldType: row.campaignAsset?.fieldType || null,
    status: mapStatus(row.campaignAsset?.status),
  }));

// ── Conversion-action configuration ──────────────────────────────────────────

/**
 * Normalize conversion-action config rows. No metrics — this captures whether
 * the account tracks conversions, which actions are primary (what Smart Bidding
 * optimizes toward), and what each measures. Powers GOOGLE-CONV-001.
 */
export const normalizeConversionActions = (rows = []) =>
  (rows || []).map((row) => ({
    level: "conversion_action",
    id: row.conversionAction?.id != null ? String(row.conversionAction.id) : null,
    name: row.conversionAction?.name || null,
    status: mapStatus(row.conversionAction?.status),
    type: row.conversionAction?.type || null,
    category: row.conversionAction?.category || null,
    primaryForGoal: row.conversionAction?.primaryForGoal === true,
    countingType: row.conversionAction?.countingType || null,
  }));

// ── Ad group-level (equivalent to ad sets in Meta) ──────────────────────────

export const normalizeAdGroups = (rows) =>
  rows.map((row) => ({
    level: "adset",
    name: row.adGroup?.name || null,
    adGroupId: row.adGroup?.id || null,
    adGroupType: row.adGroup?.type || null,
    campaignName: row.campaign?.name || null,
    campaignId: row.campaign?.id || null,
    status: mapStatus(row.adGroup?.status),
    spend: microsToDecimal(row.metrics?.costMicros),
    impressions: parseNumber(row.metrics?.impressions),
    clicks: parseNumber(row.metrics?.clicks),
    ctr: parseNumber(row.metrics?.ctr),
    cpc: microsToDecimal(row.metrics?.averageCpc),
    results: parseNumber(row.metrics?.conversions),
    cpa: microsToDecimal(row.metrics?.costPerConversion),
    reach: null,
    frequency: null,
    dateStart: null,
    dateEnd: null,
  }));

// ── Ad-level ────────────────────────────────────────────────────────────────

export const normalizeAds = (rows) =>
  rows.map((row) => ({
    level: "ad",
    name: row.adGroupAd?.ad?.name || `Ad #${row.adGroupAd?.ad?.id}` || null,
    adId: row.adGroupAd?.ad?.id || null,
    adType: row.adGroupAd?.ad?.type || null,
    adStrength: row.adGroupAd?.adStrength || null,
    adGroupId: row.adGroup?.id || null,
    adGroupName: row.adGroup?.name || null,
    campaignId: row.campaign?.id || null,
    campaignName: row.campaign?.name || null,
    status: mapStatus(row.adGroupAd?.status),
    spend: microsToDecimal(row.metrics?.costMicros),
    impressions: parseNumber(row.metrics?.impressions),
    clicks: parseNumber(row.metrics?.clicks),
    ctr: parseNumber(row.metrics?.ctr),
    results: parseNumber(row.metrics?.conversions),
    reach: null,
    frequency: null,
    dateStart: null,
    dateEnd: null,
  }));

// ── Keyword-level ────────────────────────────────────────────────────────────

export const normalizeKeywords = (rows) =>
  rows.map((row) => ({
    level: "keyword",
    criterionId: row.adGroupCriterion?.criterionId || null,
    keywordText: row.adGroupCriterion?.keyword?.text || null,
    matchType: row.adGroupCriterion?.keyword?.matchType || null,
    qualityScore: parseNumber(row.adGroupCriterion?.qualityInfo?.qualityScore),
    // QS component buckets: ABOVE_AVERAGE | AVERAGE | BELOW_AVERAGE. Tell us WHICH
    // lever drags Quality Score (ad relevance / landing page / expected CTR).
    adRelevance: row.adGroupCriterion?.qualityInfo?.creativeQualityScore || null,
    landingPageExperience: row.adGroupCriterion?.qualityInfo?.postClickQualityScore || null,
    expectedCtr: row.adGroupCriterion?.qualityInfo?.searchPredictedCtr || null,
    status: mapStatus(row.adGroupCriterion?.status),
    effectiveCpcBid: microsToDecimal(row.adGroupCriterion?.effectiveCpcBidMicros),
    adGroupName: row.adGroup?.name || null,
    adGroupId: row.adGroup?.id || null,
    campaignName: row.campaign?.name || null,
    campaignId: row.campaign?.id || null,
    bidStrategy: row.campaign?.biddingStrategyType || null,
    spend: microsToDecimal(row.metrics?.costMicros),
    impressions: parseNumber(row.metrics?.impressions),
    clicks: parseNumber(row.metrics?.clicks),
    ctr: parseNumber(row.metrics?.ctr),
    cpc: microsToDecimal(row.metrics?.averageCpc),
    conversions: parseNumber(row.metrics?.conversions),
    cpa: microsToDecimal(row.metrics?.costPerConversion),
  }));

// ── Search term-level ────────────────────────────────────────────────────────

export const normalizeSearchTerms = (rows) =>
  rows.map((row) => ({
    level: "search_term",
    searchTerm: row.searchTermView?.searchTerm || null,
    status: row.searchTermView?.status || null,
    adGroupName: row.adGroup?.name || null,
    adGroupId: row.adGroup?.id || null,
    campaignName: row.campaign?.name || null,
    campaignId: row.campaign?.id || null,
    spend: microsToDecimal(row.metrics?.costMicros),
    impressions: parseNumber(row.metrics?.impressions),
    clicks: parseNumber(row.metrics?.clicks),
    ctr: parseNumber(row.metrics?.ctr),
    conversions: parseNumber(row.metrics?.conversions),
    cpa: microsToDecimal(row.metrics?.costPerConversion),
  }));

// ── Negative keyword shared lists ────────────────────────────────────────────

export const normalizeNegativeKeywordLists = (rows) =>
  rows.map((row) => ({
    level: "negative_list",
    listId: row.sharedSet?.id || null,
    name: row.sharedSet?.name || null,
    memberCount: parseNumber(row.sharedSet?.memberCount),
    referenceCount: parseNumber(row.sharedSet?.referenceCount),
    status: row.sharedSet?.status || null,
  }));

// ── PMax asset group assets ──────────────────────────────────────────────────

export const normalizePMaxAssets = (rows) =>
  rows.map((row) => ({
    level: "asset",
    assetId: row.asset?.id || null,
    assetName: row.asset?.name || null,
    assetType: row.asset?.type || null,
    fieldType: row.assetGroupAsset?.fieldType || null,
    status: mapStatus(row.assetGroupAsset?.status),
    adGroupName: row.assetGroup?.name || null,
    adGroupId: row.assetGroup?.id || null,
    campaignName: row.campaign?.name || null,
    campaignId: row.campaign?.id || null,
  }));

// ── Shopping product feed ────────────────────────────────────────────────────

export const normalizeShoppingProducts = (rows) =>
  rows.map((row) => ({
    level: "feed",
    itemId: row.shoppingProduct?.itemId || null,
    title: row.shoppingProduct?.title || null,
    brand: row.shoppingProduct?.brand || null,
    status: row.shoppingProduct?.status || null,
    issues: row.shoppingProduct?.issues || [],
  }));

// ── Audience bidding (ad group user list criteria) ───────────────────────────

export const normalizeAudienceBidding = (rows) =>
  rows.map((row) => ({
    level: "audience",
    criterionId: row.adGroupCriterion?.criterionId || null,
    userListResourceName: row.adGroupCriterion?.userList?.userList || null,
    bidModifier: parseNumber(row.adGroupCriterion?.bidModifier),
    status: mapStatus(row.adGroupCriterion?.status),
    adGroupName: row.adGroup?.name || null,
    adGroupId: row.adGroup?.id || null,
    campaignName: row.campaign?.name || null,
    campaignId: row.campaign?.id || null,
  }));

// ── Audience performance (ad_group_audience_view, WITH metrics) ──────────────

/**
 * Normalize per-campaign audience performance rows. The criterionId is the
 * stable cross-campaign join key (Google's audience/segment id) used to detect
 * the same segment running well in one campaign and badly in another.
 */
export const normalizeAudiencePerformance = (rows = [], audienceNames = {}) =>
  (rows || [])
    .map((row) => {
      const criterionId =
        row.adGroupCriterion?.criterionId != null
          ? String(row.adGroupCriterion.criterionId)
          : null;
      const audienceType = row.adGroupCriterion?.type || null;
      const userList = row.adGroupCriterion?.userList?.userList || null;
      const customAudience = row.adGroupCriterion?.customAudience?.customAudience || null;
      // Resolved display name, if the resource lookup found one (best-effort).
      const audienceName =
        (userList && audienceNames[userList]) ||
        (customAudience && audienceNames[customAudience]) ||
        null;
      const spend = microsToDecimal(row.metrics?.costMicros);
      const conversions = parseNumber(row.metrics?.conversions);
      return {
        level: "audience_performance",
        criterionId,
        audienceType,
        userList,
        customAudience,
        audienceName,
        // Prefer the resolved name; fall back to the type + id when it's
        // unavailable. criterionId is still what the rule matches on.
        audienceLabel: audienceName
          ? audienceName
          : criterionId
            ? `${audienceType || "Audience"} #${criterionId}`
            : audienceType || "Audience",
        campaignId: row.campaign?.id || null,
        campaignName: row.campaign?.name || null,
        adGroupId: row.adGroup?.id || null,
        adGroupName: row.adGroup?.name || null,
        spend,
        impressions: parseNumber(row.metrics?.impressions),
        clicks: parseNumber(row.metrics?.clicks),
        ctr: parseNumber(row.metrics?.ctr),
        cpc: microsToDecimal(row.metrics?.averageCpc),
        conversions,
        convValue: parseNumber(row.metrics?.conversionsValue),
        cpa:
          conversions && conversions > 0 && spend != null
            ? spend / conversions
            : microsToDecimal(row.metrics?.costPerConversion),
      };
    })
    // Drop empty rows; keep anything with spend or impressions.
    .filter((r) => (r.spend || 0) > 0 || (r.impressions || 0) > 0);

// ── Campaign × device performance (segments.device FROM campaign) ────────────

export const normalizeCampaignDevicePerformance = (rows = []) =>
  (rows || [])
    .map((row) => {
      const spend = microsToDecimal(row.metrics?.costMicros);
      const conversions = parseNumber(row.metrics?.conversions);
      return {
        level: "campaign_device",
        campaignId: row.campaign?.id || null,
        campaignName: row.campaign?.name || null,
        device: row.segments?.device || "UNKNOWN",
        spend,
        impressions: parseNumber(row.metrics?.impressions),
        clicks: parseNumber(row.metrics?.clicks),
        conversions,
        convValue: parseNumber(row.metrics?.conversionsValue),
        cpa: conversions && conversions > 0 && spend != null ? spend / conversions : null,
      };
    })
    .filter((r) => (r.spend || 0) > 0 || (r.impressions || 0) > 0);

// ── Landing page performance (landing_page_view) ─────────────────────────────

export const normalizeLandingPagePerformance = (rows = []) =>
  (rows || [])
    .map((row) => {
      const spend = microsToDecimal(row.metrics?.costMicros);
      const clicks = parseNumber(row.metrics?.clicks);
      const conversions = parseNumber(row.metrics?.conversions);
      return {
        level: "landing_page",
        url: row.landingPageView?.unexpandedFinalUrl || null,
        spend,
        impressions: parseNumber(row.metrics?.impressions),
        clicks,
        conversions,
        convValue: parseNumber(row.metrics?.conversionsValue),
        cvr: clicks && clicks > 0 && conversions != null ? conversions / clicks : null,
        cpa: conversions && conversions > 0 && spend != null ? spend / conversions : null,
      };
    })
    .filter((r) => r.url && ((r.spend || 0) > 0 || (r.clicks || 0) > 0));

// ── Geographic performance (geographic_view) ─────────────────────────────────

/**
 * @param rows       raw geographic_view rows
 * @param geoNames   { id → { name, countryCode } } from resolveGeoTargetNames
 */
export const normalizeGeoPerformance = (rows = [], geoNames = {}) =>
  (rows || [])
    .map((row) => {
      const countryId =
        row.geographicView?.countryCriterionId != null
          ? String(row.geographicView.countryCriterionId)
          : null;
      const resolved = countryId ? geoNames[countryId] : null;
      const spend = microsToDecimal(row.metrics?.costMicros);
      const conversions = parseNumber(row.metrics?.conversions);
      return {
        level: "geo",
        countryId,
        country: resolved?.name || (countryId ? `geo ${countryId}` : "unknown"),
        countryCode: resolved?.countryCode || null,
        locationType: row.geographicView?.locationType || null,
        campaignName: row.campaign?.name || null,
        spend,
        impressions: parseNumber(row.metrics?.impressions),
        clicks: parseNumber(row.metrics?.clicks),
        conversions,
        convValue: parseNumber(row.metrics?.conversionsValue),
        cpa: conversions && conversions > 0 && spend != null ? spend / conversions : null,
      };
    })
    .filter((r) => (r.spend || 0) > 0 || (r.impressions || 0) > 0);

// ── Dataset assembly ─────────────────────────────────────────────────────────

const sumField = (records, field) =>
  records.reduce((total, r) => total + (r[field] || 0), 0);

const microsToUnits = (micros) => {
  const n = Number(micros);
  return Number.isFinite(n) ? Math.round((n / 1_000_000) * 100) / 100 : 0;
};

/**
 * Normalize Google daily segment rows (segments.date) into byDay records.
 */
export const normalizeGoogleDailySegments = (rows = []) =>
  rows.map((row) => ({
    date: row.segments?.date || null,
    spend: microsToUnits(row.metrics?.costMicros),
    impressions: Number(row.metrics?.impressions || 0),
    clicks: Number(row.metrics?.clicks || 0),
    conversions: Number(row.metrics?.conversions || 0),
    convValue: Number(row.metrics?.conversionsValue || 0),
  }));

/**
 * Normalize account-level segment rows (device / day-of-week / network) into
 * the byDimension record shape the rule engine + Deep Audit consume:
 *   { dimension, segment, spend, impressions, clicks, conversions, convValue }
 */
const normalizeGoogleSegment = (rows, dimension, segmentKey) =>
  (rows || [])
    .map((row) => ({
      dimension,
      segment:
        row.segments?.[segmentKey] != null
          ? String(row.segments[segmentKey])
          : "unknown",
      spend: microsToUnits(row.metrics?.costMicros),
      impressions: Number(row.metrics?.impressions || 0),
      clicks: Number(row.metrics?.clicks || 0),
      conversions: Number(row.metrics?.conversions || 0),
      convValue: Number(row.metrics?.conversionsValue || 0),
    }))
    .filter((r) => r.spend > 0 || r.impressions > 0);

/**
 * Build the byDimension map from raw segment-breakdown rows keyed by dimension.
 * Accepts { device, dayOfWeek, network } (Google API segment field names).
 * Empty dimensions are omitted so the engine only sees dimensions with data.
 */
export const buildGoogleByDimension = (breakdowns = {}) => {
  const byDimension = {};
  const device = normalizeGoogleSegment(breakdowns.device, "device", "device");
  const dayOfWeek = normalizeGoogleSegment(breakdowns.dayOfWeek, "dayOfWeek", "dayOfWeek");
  const network = normalizeGoogleSegment(breakdowns.network, "network", "adNetworkType");
  if (device.length) byDimension.device = device;
  if (dayOfWeek.length) byDimension.dayOfWeek = dayOfWeek;
  if (network.length) byDimension.network = network;
  return byDimension;
};

export const buildGoogleNormalizedDataset = ({
  campaignRecords,
  adGroupRecords,
  adRecords,
  keywordRecords = [],
  searchTermRecords = [],
  negativeListRecords = [],
  pmaxAssetRecords = [],
  shoppingProductRecords = [],
  audienceBiddingRecords = [],
  audiencePerformanceRecords = [],
  campaignDeviceRecords = [],
  landingPageRecords = [],
  geoRecords = [],
  conversionActionRecords = [],
  campaignAssetRecords = [],
  currency,
  byDay = [],
  byDimension = {},
}) => {
  const allRecords = [
    ...campaignRecords,
    ...adGroupRecords,
    ...adRecords,
    ...keywordRecords,
    ...searchTermRecords,
    ...negativeListRecords,
    ...pmaxAssetRecords,
    ...shoppingProductRecords,
    ...audienceBiddingRecords,
    ...audiencePerformanceRecords,
    ...campaignDeviceRecords,
    ...landingPageRecords,
    ...geoRecords,
    ...conversionActionRecords,
    ...campaignAssetRecords,
  ];

  const byLevel = {
    campaign: campaignRecords,
    adset: adGroupRecords,
    ad: adRecords,
    keyword: keywordRecords,
    search_term: searchTermRecords,
    negative_list: negativeListRecords,
    asset: pmaxAssetRecords,
    feed: shoppingProductRecords,
    audience: audienceBiddingRecords,
    audience_performance: audiencePerformanceRecords,
    campaign_device: campaignDeviceRecords,
    landing_page: landingPageRecords,
    geo: geoRecords,
    conversion_action: conversionActionRecords,
    campaign_asset: campaignAssetRecords,
  };

  const summary = {
    uploadedFiles: 1,
    rowCount: allRecords.length,
    spend: sumField(campaignRecords, "spend"),
    impressions: sumField(campaignRecords, "impressions"),
    clicks: sumField(campaignRecords, "clicks"),
    conversions: sumField(campaignRecords, "results"),
    reach: null,
    currency: currency || null,
    source: "OAUTH",
  };

  return {
    data: {
      platforms: {
        GOOGLE: {
          files: [],
          records: allRecords,
          byLevel,
          byDimension,
          byDay: Array.isArray(byDay) ? byDay : [],
          currency: currency || null,
          source: "OAUTH",
        },
      },
    },
    summary: {
      platforms: { GOOGLE: summary },
      totals: summary,
    },
  };
};
