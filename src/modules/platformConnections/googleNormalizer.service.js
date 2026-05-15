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
      reach: null,
      frequency: null,
      dateStart: null,
      dateEnd: null,
    };
  });

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
    adGroupName: row.adGroup?.name || null,
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

// ── Dataset assembly ─────────────────────────────────────────────────────────

const sumField = (records, field) =>
  records.reduce((total, r) => total + (r[field] || 0), 0);

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
  currency,
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
