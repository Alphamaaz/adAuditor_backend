import axios from "axios";

const GRAPH_API_VERSION = "v19.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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
      date_preset: datePreset,
      fields: [
        "campaign_name",
        "campaign_id",
        "objective",
        "spend",
        "impressions",
        "clicks",
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
      date_preset: datePreset,
      fields: [
        "campaign_name",
        "adset_name",
        "adset_id",
        "spend",
        "impressions",
        "clicks",
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
      date_preset: datePreset,
      fields: [
        "campaign_name",
        "adset_name",
        "ad_name",
        "ad_id",
        "spend",
        "impressions",
        "clicks",
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
      fields: "name,status,effective_status,adset_id,adset{name},campaign_id,campaign{name}",
      limit: 500,
    },
  });
  return data.data || [];
};
