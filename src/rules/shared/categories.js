export const PLATFORM_CATEGORIES = {
  META: {
    "Tracking & Pixel Health": 20,
    "Campaign Structure": 20,
    "Audience Strategy": 20,
    "Creative Performance": 15,
    "Bidding & Budget": 15,
    "Retargeting Coverage": 10,
    "Attribution & Reporting": 10,
  },
  GOOGLE: {
    "Conversion Tracking Setup": 20,
    "Campaign Structure": 18,
    "Keyword Strategy": 18,
    "Bidding Strategy Alignment": 15,
    "Ad Copy & Extensions": 12,
    "Quality Score & Relevance": 10,
    "Audience & Attribution": 7,
  },
  TIKTOK: {
    "Pixel & Tracking Health": 22,
    "Creative Performance": 25,
    "Campaign Structure": 18,
    "Audience Strategy": 15,
    "Bidding & Budget": 12,
    "Attribution & Reporting": 8,
  },
};

export const PLATFORM_LABELS = {
  META: "Meta",
  GOOGLE: "Google",
  TIKTOK: "TikTok",
};

export const getTrackingCategory = (platform) =>
  ({
    META: "Tracking & Pixel Health",
    GOOGLE: "Conversion Tracking Setup",
    TIKTOK: "Pixel & Tracking Health",
  })[platform] || "Attribution & Reporting";

export const getBiddingCategory = (platform) =>
  ({
    META: "Bidding & Budget",
    GOOGLE: "Bidding Strategy Alignment",
    TIKTOK: "Bidding & Budget",
  })[platform] || "Bidding & Budget";

export const getAttributionCategory = (platform) =>
  ({
    META: "Attribution & Reporting",
    GOOGLE: "Audience & Attribution",
    TIKTOK: "Attribution & Reporting",
  })[platform] || "Attribution & Reporting";
