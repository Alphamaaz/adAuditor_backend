import axios from "axios";

const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

const APP_ID = () => process.env.TIKTOK_APP_ID;
const APP_SECRET = () => process.env.TIKTOK_APP_SECRET;

/**
 * Exchange the auth_code (TikTok Business API) for an access token.
 * TikTok Business API uses app_id/secret, not client_key/client_secret.
 */
export const exchangeCodeForToken = async (authCode) => {
  const { data } = await axios.post(
    `${TIKTOK_API_BASE}/oauth2/access_token/`,
    { app_id: APP_ID(), secret: APP_SECRET(), auth_code: authCode },
    { headers: { "Content-Type": "application/json" } }
  );

  if (data.code !== 0) {
    throw new Error(`TikTok Auth Error: ${data.message} (Code: ${data.code})`);
  }

  return data.data; // { access_token, advertiser_ids, scope, token_type }
};

/**
 * Get the list of advertiser accounts associated with the access token.
 */
export const fetchAdvertiserList = async (accessToken) => {
  const { data } = await axios.get(`${TIKTOK_API_BASE}/oauth2/advertiser/get/`, {
    params: { app_id: APP_ID(), secret: APP_SECRET(), access_token: accessToken },
  });

  if (data.code !== 0) {
    throw new Error(`TikTok API Error: ${data.message} (Code: ${data.code})`);
  }

  return data.data?.list || [];
};

// ── Date helpers ──────────────────────────────────────────────────────────────

const getDateRange = (daysBack) => {
  const end = new Date();
  end.setDate(end.getDate() - 1); // yesterday
  const start = new Date(end);
  start.setDate(start.getDate() - (daysBack - 1));
  const fmt = (d) => d.toISOString().split("T")[0];
  return { start_date: fmt(start), end_date: fmt(end) };
};

// ── Generic paginated report fetcher ──────────────────────────────────────────

const fetchReport = async (accessToken, advertiserId, dataLevel, dimensions, metrics, startDate, endDate) => {
  const allItems = [];
  let page = 1;

  while (true) {
    const { data } = await axios.get(`${TIKTOK_API_BASE}/report/integrated/get/`, {
      headers: { "Access-Token": accessToken },
      params: {
        advertiser_id: advertiserId,
        report_type: "BASIC",
        data_level: dataLevel,
        dimensions: JSON.stringify(dimensions),
        metrics: JSON.stringify(metrics),
        start_date: startDate,
        end_date: endDate,
        page_size: 1000,
        page,
      },
    });

    if (data.code !== 0) {
      throw new Error(`TikTok Reporting Error: ${data.message} (Code: ${data.code})`);
    }

    const list = data.data?.list || [];
    allItems.push(...list);
    if (list.length < 1000) break;
    page++;
  }

  return allItems;
};

// ── Report fetch functions ────────────────────────────────────────────────────

const CAMPAIGN_METRICS = [
  "campaign_name",
  "objective_type",
  "campaign_budget",
  "campaign_budget_mode",
  "spend",
  "impressions",
  "clicks",
  "reach",
  "conversion",
  "cost_per_conversion",
  "conversion_rate",
  "ctr",
  "cpc",
  "cpm",
];

const ADGROUP_METRICS = [
  "adgroup_name",
  "spend",
  "impressions",
  "clicks",
  "reach",
  "conversion",
  "cost_per_conversion",
  "conversion_rate",
  "ctr",
  "cpc",
  "cpm",
  "bid_price",
  "optimization_goal",
  "placement_type",
  "budget",
  "status",
];

const AD_METRICS = [
  "ad_name",
  "spend",
  "impressions",
  "clicks",
  "reach",
  "conversion",
  "cost_per_conversion",
  "conversion_rate",
  "ctr",
  "cpc",
  "cpm",
  "status",
];

export const fetchCampaignReport = async (accessToken, advertiserId, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(accessToken, advertiserId, "AUCTION_CAMPAIGN", ["campaign_id"], CAMPAIGN_METRICS, start_date, end_date);
};

export const fetchAdGroupReport = async (accessToken, advertiserId, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(
    accessToken, advertiserId, "AUCTION_ADGROUP",
    ["adgroup_id", "campaign_id"], ADGROUP_METRICS, start_date, end_date
  );
};

export const fetchAdReport = async (accessToken, advertiserId, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(
    accessToken, advertiserId, "AUCTION_AD",
    ["ad_id", "adgroup_id", "campaign_id"], AD_METRICS, start_date, end_date
  );
};
