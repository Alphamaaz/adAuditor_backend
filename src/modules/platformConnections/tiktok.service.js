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
  // TikTok's Business API reads the token ONLY from the Access-Token header —
  // an access_token query param is silently ignored, which is why this
  // endpoint reported "The access_token is empty" (code 40104) with a real,
  // valid token. fetchReport below already does this correctly.
  const { data } = await axios.get(`${TIKTOK_API_BASE}/oauth2/advertiser/get/`, {
    headers: { "Access-Token": accessToken },
    params: { app_id: APP_ID(), secret: APP_SECRET() },
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

const fetchReport = async (accessToken, advertiserId, dataLevel, dimensions, metrics, startDate, endDate, reportType = "BASIC") => {
  const allItems = [];
  let page = 1;

  while (true) {
    const { data } = await axios.get(`${TIKTOK_API_BASE}/report/integrated/get/`, {
      headers: { "Access-Token": accessToken },
      params: {
        advertiser_id: advertiserId,
        report_type: reportType,
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

// Audience-breakdown reports (report_type=AUDIENCE) carry one row per segment
// value with metrics — the TikTok analog of Meta age/gender/placement and Google
// device/network breakdowns. Powers SEG-WASTE-001 + the Deep Audit segment tool
// for TikTok (byDimension was empty before this).
const AUDIENCE_METRICS = ["spend", "impressions", "clicks", "conversion"];

/**
 * Fetch an account-level audience breakdown for one dimension (e.g. "age",
 * "gender", "country_code"). Best-effort at the call site.
 */
export const fetchAudienceReport = async (accessToken, advertiserId, dimension, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(
    accessToken, advertiserId, "AUCTION_ADVERTISER",
    ["advertiser_id", dimension], AUDIENCE_METRICS, start_date, end_date, "AUDIENCE"
  );
};

/**
 * Fetch the standard audience breakdowns (age, gender, country). Best-effort per
 * dimension — a failure on one returns [] for that dimension and never throws,
 * so a single unsupported breakdown can't fail the whole sync.
 */
export const fetchAudienceBreakdowns = async (accessToken, advertiserId, daysBack = 30) => {
  const dims = [
    { key: "age", dimension: "age" },
    { key: "gender", dimension: "gender" },
    { key: "country", dimension: "country_code" },
  ];
  const out = {};
  for (const { key, dimension } of dims) {
    try {
      out[key] = await fetchAudienceReport(accessToken, advertiserId, dimension, daysBack);
      console.log(`[TikTok Ads] ✓ Fetched ${out[key].length} '${key}' audience row(s).`);
    } catch (err) {
      console.warn(`[TikTok Ads] audience breakdown '${key}' unavailable: ${err.message}`);
      out[key] = [];
    }
  }
  return out;
};
