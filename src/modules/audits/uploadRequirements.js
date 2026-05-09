export const SAMPLE_SUPPORTED_REPORTS = {
  META: ["AD_PERFORMANCE_30D", "AD_PERFORMANCE_90D", "AD_PERFORMANCE"],
  GOOGLE: ["TIME_SERIES"],
  TIKTOK: [
    "CAMPAIGN_PERFORMANCE_30D",
    "CAMPAIGN_PERFORMANCE_90D",
    "CAMPAIGN_PERFORMANCE",
  ],
};

export const REQUIRED_UPLOAD_REPORTS = {
  META: [
    {
      id: "CAMPAIGN_PERFORMANCE_30D",
      label: "Campaign Performance, last 30 days",
    },
    {
      id: "CAMPAIGN_PERFORMANCE_90D",
      label: "Campaign Performance, last 90 days",
    },
    {
      id: "AD_SET_PERFORMANCE_30D",
      label: "Ad Set Performance, last 30 days",
    },
    {
      id: "AD_SET_PERFORMANCE_90D",
      label: "Ad Set Performance, last 90 days",
    },
    {
      id: "AD_PERFORMANCE_30D",
      label: "Ad Performance, last 30 days",
    },
    {
      id: "AD_PERFORMANCE_90D",
      label: "Ad Performance, last 90 days",
    },
    {
      id: "AUDIENCE_DETAILS",
      label: "Audience Details Export",
    },
    {
      id: "PIXEL_EVENTS_30D",
      label: "Pixel Event Report, last 30 days",
    },
  ],
  GOOGLE: [
    {
      id: "CAMPAIGN_PERFORMANCE_30D",
      label: "Campaign Performance Report, last 30 days",
    },
    {
      id: "CAMPAIGN_PERFORMANCE_90D",
      label: "Campaign Performance Report, last 90 days",
    },
    {
      id: "AD_GROUP_REPORT_30D",
      label: "Ad Group Report, last 30 days",
    },
    {
      id: "KEYWORD_REPORT_30D",
      label: "Keyword Report, last 30 days",
    },
    {
      id: "SEARCH_TERMS_30D",
      label: "Search Terms Report, last 30 days",
    },
    {
      id: "AD_COPY_REPORT_30D",
      label: "Ad Copy Report, last 30 days",
    },
    {
      id: "AUDIENCE_BIDDING_30D",
      label: "Audience & Bidding Report, last 30 days",
    },
    {
      id: "ASSET_REPORT_30D",
      label: "Asset Report for PMax, last 30 days",
    },
    {
      id: "SHOPPING_PMAX_FEED",
      label: "Shopping/PMax Feed, current",
    },
  ],
  TIKTOK: [
    {
      id: "CAMPAIGN_PERFORMANCE_30D",
      label: "Campaign Performance, last 30 days",
    },
    {
      id: "CAMPAIGN_PERFORMANCE_90D",
      label: "Campaign Performance, last 90 days",
    },
    {
      id: "AD_GROUP_REPORT_30D",
      label: "Ad Group Report, last 30 days",
    },
    {
      id: "AD_PERFORMANCE_30D",
      label: "Ad Performance Report, last 30 days",
    },
    {
      id: "AUDIENCE_REPORT",
      label: "Audience Report, current",
    },
    {
      id: "PIXEL_EVENTS_30D",
      label: "Pixel Event Report, last 30 days",
    },
  ],
};

export const REPORT_COLUMN_ALIASES = {
  META: {
    CAMPAIGN_PERFORMANCE_30D: "META_PERFORMANCE",
    CAMPAIGN_PERFORMANCE_90D: "META_PERFORMANCE",
    AD_SET_PERFORMANCE_30D: "META_PERFORMANCE",
    AD_SET_PERFORMANCE_90D: "META_PERFORMANCE",
    AD_PERFORMANCE_30D: "META_AD_PERFORMANCE",
    AD_PERFORMANCE_90D: "META_AD_PERFORMANCE",
    AD_PERFORMANCE: "META_AD_PERFORMANCE",
    AUDIENCE_DETAILS: "META_AUDIENCE",
    PIXEL_EVENTS_30D: "PIXEL_EVENTS",
  },
  GOOGLE: {
    TIME_SERIES: "GOOGLE_TIME_SERIES",
    CAMPAIGN_PERFORMANCE_30D: "GOOGLE_PERFORMANCE",
    CAMPAIGN_PERFORMANCE_90D: "GOOGLE_PERFORMANCE",
    AD_GROUP_REPORT_30D: "GOOGLE_PERFORMANCE",
    KEYWORD_REPORT_30D: "GOOGLE_KEYWORDS",
    SEARCH_TERMS_30D: "GOOGLE_SEARCH_TERMS",
    AD_COPY_REPORT_30D: "GOOGLE_AD_COPY",
    AUDIENCE_BIDDING_30D: "GOOGLE_AUDIENCE",
    ASSET_REPORT_30D: "GOOGLE_ASSETS",
    SHOPPING_PMAX_FEED: "GOOGLE_FEED",
  },
  TIKTOK: {
    CAMPAIGN_PERFORMANCE_30D: "TIKTOK_CAMPAIGN_PERFORMANCE",
    CAMPAIGN_PERFORMANCE_90D: "TIKTOK_CAMPAIGN_PERFORMANCE",
    CAMPAIGN_PERFORMANCE: "TIKTOK_CAMPAIGN_PERFORMANCE",
    AD_GROUP_REPORT_30D: "TIKTOK_PERFORMANCE",
    AD_PERFORMANCE_30D: "TIKTOK_PERFORMANCE",
    AUDIENCE_REPORT: "TIKTOK_AUDIENCE",
    PIXEL_EVENTS_30D: "PIXEL_EVENTS",
  },
};

/**
 * Required column "specs" — each entry is either a plain string (exact alias
 * to match against header) or a regex (matches header pattern, e.g. for
 * multi-currency columns like "Amount spent (USD)").
 */
export const REQUIRED_COLUMNS_BY_ALIAS = {
  META_PERFORMANCE: [/^amount spent/i, "Impressions", "Reach"],
  META_AD_PERFORMANCE: [
    "Ad name",
    /^amount spent/i,
    "Impressions",
    "Reach",
  ],
  META_AUDIENCE: ["Audience", /^amount spent/i],
  PIXEL_EVENTS: ["Event"],
  GOOGLE_TIME_SERIES: ["Month", "Cost", "Conversions", "Impr."],
  GOOGLE_PERFORMANCE: [
    "Campaign",
    "Cost",
    "Impr.",
    "Clicks",
    "Conversions",
  ],
  GOOGLE_KEYWORDS: ["Keyword", "Match type", "Cost", "Impr."],
  GOOGLE_SEARCH_TERMS: ["Search term", "Cost", "Conversions", "Clicks"],
  GOOGLE_AD_COPY: ["Ad", "Impr.", "Clicks"],
  GOOGLE_AUDIENCE: ["Audience", "Cost"],
  GOOGLE_ASSETS: ["Asset", "Performance"],
  GOOGLE_FEED: ["Item"],
  TIKTOK_CAMPAIGN_PERFORMANCE: [
    "Campaign name",
    "Cost",
    "Impressions",
    "Clicks",
  ],
  TIKTOK_PERFORMANCE: ["Cost", "Impressions", "Clicks"],
  TIKTOK_AUDIENCE: ["Audience", "Cost"],
};

export const getRequiredColumns = (platform, reportType) => {
  const alias = REPORT_COLUMN_ALIASES[platform]?.[reportType];
  return REQUIRED_COLUMNS_BY_ALIAS[alias] || [];
};

/**
 * Maps a (platform, reportType) pair to a canonical entity level.
 * Used by the rule engine to know which records to scan.
 */
export const REPORT_LEVEL_MAP = {
  META: {
    CAMPAIGN_PERFORMANCE_30D: "campaign",
    CAMPAIGN_PERFORMANCE_90D: "campaign",
    AD_SET_PERFORMANCE_30D: "adset",
    AD_SET_PERFORMANCE_90D: "adset",
    AD_PERFORMANCE_30D: "ad",
    AD_PERFORMANCE_90D: "ad",
    AD_PERFORMANCE: "ad",
    AUDIENCE_DETAILS: "audience",
    PIXEL_EVENTS_30D: "pixel_event",
  },
  GOOGLE: {
    TIME_SERIES: "time_series",
    CAMPAIGN_PERFORMANCE_30D: "campaign",
    CAMPAIGN_PERFORMANCE_90D: "campaign",
    AD_GROUP_REPORT_30D: "ad_group",
    KEYWORD_REPORT_30D: "keyword",
    SEARCH_TERMS_30D: "search_term",
    AD_COPY_REPORT_30D: "ad_copy",
    AUDIENCE_BIDDING_30D: "audience",
    ASSET_REPORT_30D: "asset",
    SHOPPING_PMAX_FEED: "feed",
  },
  TIKTOK: {
    CAMPAIGN_PERFORMANCE_30D: "campaign",
    CAMPAIGN_PERFORMANCE_90D: "campaign",
    CAMPAIGN_PERFORMANCE: "campaign",
    AD_GROUP_REPORT_30D: "ad_group",
    AD_PERFORMANCE_30D: "ad",
    AUDIENCE_REPORT: "audience",
    PIXEL_EVENTS_30D: "pixel_event",
  },
};

export const getReportLevel = (platform, reportType) =>
  REPORT_LEVEL_MAP[platform]?.[reportType] || null;
