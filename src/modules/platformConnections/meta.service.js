import axios from "axios";

const GRAPH_API_VERSION = "v19.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

// Build the date filter params for a Meta insights call.
// Accepts a string date_preset ("last_30d", "last_90d", …) for known Meta
// presets, or a {since, until} object for custom windows (uses time_range).
const buildDateParams = (dateParam) => {
  if (typeof dateParam === "string") return { date_preset: dateParam };
  if (dateParam && typeof dateParam === "object" && dateParam.since) {
    return { time_range: JSON.stringify(dateParam) };
  }
  return { date_preset: "last_30d" };
};

const APP_ID = () => process.env.META_APP_ID;
const APP_SECRET = () => process.env.META_APP_SECRET;

/**
 * Exchange a short-lived code for a short-lived access token.
 */
export const exchangeCodeForToken = async (code, redirectUri) => {
  const { data } = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      client_id: APP_ID(),
      client_secret: APP_SECRET(),
      redirect_uri: redirectUri,
      code,
    },
  });
  return data; // { access_token, token_type, expires_in }
};

/**
 * Exchange a short-lived access token for a long-lived one (60 days).
 */
export const getLongLivedToken = async (shortLivedToken) => {
  const { data } = await axios.get(`${GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: "fb_exchange_token",
      client_id: APP_ID(),
      client_secret: APP_SECRET(),
      fb_exchange_token: shortLivedToken,
    },
  });
  return data; // { access_token, token_type, expires_in }
};

/**
 * Verify a token is still valid and get its metadata.
 */
export const debugToken = async (accessToken) => {
  const { data } = await axios.get(`${GRAPH_BASE}/debug_token`, {
    params: {
      input_token: accessToken,
      access_token: `${APP_ID()}|${APP_SECRET()}`,
    },
  });
  return data.data; // { is_valid, expires_at, scopes, user_id, ... }
};

/**
 * Get the list of ad accounts this user has access to.
 */
export const fetchAdAccounts = async (accessToken) => {
  const { data } = await axios.get(`${GRAPH_BASE}/me/adaccounts`, {
    params: {
      access_token: accessToken,
      fields: "name,account_id,currency,account_status,business",
      limit: 100,
    },
  });
  return data.data || []; // Array of { id, name, account_id, currency, ... }
};

/**
 * Fetch campaign insights for a given ad account.
 * datePreset: 'last_30d' | 'last_90d'
 */
export const fetchCampaignInsights = async (accessToken, adAccountId, datePreset = "last_30d") => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      level: "campaign",
      ...buildDateParams(datePreset),
      fields: [
        "campaign_name",
        "campaign_id",
        "objective",
        "spend",
        "impressions",
        "clicks",
        "inline_link_clicks",
        "reach",
        "frequency",
        "cpm",
        "cpc",
        "ctr",
        "actions",
        "cost_per_action_type",
        "purchase_roas",
        "date_start",
        "date_stop",
      ].join(","),
      limit: 500,
    },
  });
  return data.data || [];
};

/**
 * Fetch ad set insights.
 */
export const fetchAdSetInsights = async (accessToken, adAccountId, datePreset = "last_30d") => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      level: "adset",
      ...buildDateParams(datePreset),
      fields: [
        "campaign_name",
        "adset_name",
        "adset_id",
        "spend",
        "impressions",
        "clicks",
        "inline_link_clicks",
        "reach",
        "frequency",
        "cpm",
        "cpc",
        "ctr",
        "actions",
        "cost_per_action_type",
        "purchase_roas",
        "date_start",
        "date_stop",
        "optimization_goal",
      ].join(","),
      limit: 500,
    },
  });
  return data.data || [];
};

/**
 * Fetch ad-level insights (includes ranking signals).
 */
export const fetchAdInsights = async (accessToken, adAccountId, datePreset = "last_30d") => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      level: "ad",
      ...buildDateParams(datePreset),
      fields: [
        "campaign_name",
        "adset_name",
        "ad_name",
        "ad_id",
        "spend",
        "impressions",
        "clicks",
        "inline_link_clicks",
        "reach",
        "frequency",
        "ctr",
        "actions",
        "cost_per_action_type",
        "quality_ranking",
        "engagement_rate_ranking",
        "conversion_rate_ranking",
        "date_start",
        "date_stop",
      ].join(","),
      limit: 500,
    },
  });
  return data.data || [];
};

// Insight fields shared by breakdown + daily calls.
const BREAKDOWN_FIELDS = [
  "spend",
  "impressions",
  "clicks",
  "reach",
  "actions",
  "cost_per_action_type",
  "date_start",
  "date_stop",
].join(",");

// Supported breakdowns → the Meta `breakdowns` param + the response field
// that carries the segment value. Each runs as its own account-level call
// because Meta does not allow arbitrary breakdown combinations.
export const META_BREAKDOWNS = {
  age: { param: "age", field: "age" },
  gender: { param: "gender", field: "gender" },
  placement: { param: "publisher_platform", field: "publisher_platform" },
  device: { param: "device_platform", field: "device_platform" },
  hour: {
    param: "hourly_stats_aggregated_by_advertiser_time_zone",
    field: "hourly_stats_aggregated_by_advertiser_time_zone",
  },
  region: { param: "region", field: "region" },
  // Country split — the dimension that exposes a geo misconfiguration (a campaign
  // delivering to the wrong country at a runaway CPM, the classic zero-conversion
  // root cause). Powers META-GEO-001.
  country: { param: "country", field: "country" },
};

/**
 * Fetch account-level insights segmented by a single breakdown dimension.
 * Returns raw rows; each row carries the breakdown field + metrics.
 * Best-effort: caller should tolerate rejection (not all accounts/dimensions
 * are available).
 */
export const fetchBreakdownInsights = async (
  accessToken,
  adAccountId,
  breakdownKey,
  datePreset = "last_30d"
) => {
  const cfg = META_BREAKDOWNS[breakdownKey];
  if (!cfg) return [];
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      level: "account",
      ...buildDateParams(datePreset),
      breakdowns: cfg.param,
      fields: BREAKDOWN_FIELDS,
      limit: 500,
    },
  });
  return data.data || [];
};

/**
 * Fetch account-level daily time series (time_increment=1).
 */
export const fetchDailyInsights = async (
  accessToken,
  adAccountId,
  datePreset = "last_30d"
) => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      level: "account",
      ...buildDateParams(datePreset),
      time_increment: 1,
      fields: BREAKDOWN_FIELDS,
      limit: 500,
    },
  });
  return data.data || [];
};

/**
 * Fetch campaign-level daily time series (time_increment=1). One row per
 * campaign per day — powers per-campaign trend analysis (spend/CPA inflections
 * the account-level byDay series averages away). Best-effort.
 */
export const fetchCampaignDailyInsights = async (
  accessToken,
  adAccountId,
  datePreset = "last_30d"
) => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/insights`, {
    params: {
      access_token: accessToken,
      level: "campaign",
      ...buildDateParams(datePreset),
      time_increment: 1,
      fields: `campaign_name,${BREAKDOWN_FIELDS}`,
      limit: 1000,
    },
  });
  return data.data || [];
};

/**
 * Fetch all campaigns in an account (for structure audit — status, budget etc.)
 */
export const fetchCampaigns = async (accessToken, adAccountId) => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/campaigns`, {
    params: {
      access_token: accessToken,
      fields: "name,status,objective,daily_budget,lifetime_budget,bid_strategy,effective_status",
      limit: 500,
    },
  });
  return data.data || [];
};

/**
 * Fetch ad sets (for audience and learning phase checks).
 */
export const fetchAdSets = async (accessToken, adAccountId) => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/adsets`, {
    params: {
      access_token: accessToken,
      fields: "name,status,effective_status,learning_phase_info,daily_budget,lifetime_budget,bid_strategy,targeting,campaign_id,campaign{name}",
      limit: 500,
    },
  });
  return data.data || [];
};

/**
 * Fetch all ads in an account.
 */
export const fetchAds = async (accessToken, adAccountId) => {
  const { data } = await axios.get(`${GRAPH_BASE}/${adAccountId}/ads`, {
    params: {
      access_token: accessToken,
      // `effective_status` exposes DISAPPROVED / WITH_ISSUES (the policy block
      // that can gate most of an account's delivery); `ad_review_feedback`
      // carries the specific policy reason for the narrative. `creative{...}`
      // carries the actual ad content (headline/body/CTA) so creative analysis
      // can talk about what the ads SAY, not just how they performed.
      fields:
        "name,status,effective_status,ad_review_feedback,adset_id,adset{name},campaign_id,campaign{name},creative{id,title,body,call_to_action_type,object_story_spec}",
      limit: 500,
    },
  });
  return data.data || [];
};
