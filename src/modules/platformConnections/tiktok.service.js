import axios from "axios";
import { AppError } from "../../utils/appError.js";

const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

const APP_ID = () => process.env.TIKTOK_APP_ID;
const APP_SECRET = () => process.env.TIKTOK_APP_SECRET;

const permissionErrorPattern = /permission|scope|not authori[sz]ed|access denied|no access/i;
const tokenErrorPattern = /access.?token|token.*(?:invalid|expired)|unauthenticated/i;
const rateLimitPattern = /rate.?limit|too many request|frequency limit/i;
const requestErrorPattern = /invalid (?:parameter|metric|dimension)|not supported|parameter error/i;

const requestIdSuffix = (requestId) =>
  requestId ? ` TikTok request ID: ${requestId}.` : "";

/**
 * Convert TikTok's HTTP-200 API errors and Axios transport errors into safe,
 * actionable operational errors. The raw platform response remains in server
 * logs for diagnosis; tokens and request payloads are never logged.
 */
const toTikTokError = (error, operation) => {
  if (error instanceof AppError) return error;

  const payload = error?.response?.data || error || {};
  const platformMessage = String(payload.message || error?.message || "Unknown TikTok API error");
  const platformCode = payload.code ?? null;
  const requestId = payload.request_id || payload.data?.request_id || null;
  const httpStatus = error?.response?.status || null;

  console.error(`[TikTok Ads] ${operation} failed`, {
    platformCode,
    platformMessage,
    requestId,
    httpStatus,
  });

  let statusCode = 502;
  let message = `TikTok could not return advertising data right now. Please try again.${requestIdSuffix(requestId)}`;

  if (permissionErrorPattern.test(platformMessage)) {
    statusCode = 403;
    message =
      "TikTok authorized the advertiser account, but reporting access was not granted. " +
      "Enable Reporting > Consolidated Report for this app and make sure your TikTok user can view this ad account, then reconnect it." +
      requestIdSuffix(requestId);
  } else if (tokenErrorPattern.test(platformMessage) || httpStatus === 401) {
    statusCode = 401;
    message = `The TikTok connection is no longer valid. Reconnect TikTok Ads and try again.${requestIdSuffix(requestId)}`;
  } else if (rateLimitPattern.test(platformMessage) || httpStatus === 429) {
    statusCode = 429;
    message = `TikTok's reporting limit was reached. Wait a few minutes and try again.${requestIdSuffix(requestId)}`;
  } else if (requestErrorPattern.test(platformMessage)) {
    message = `TikTok rejected part of the reporting request. Please retry after updating Ad Adviser.${requestIdSuffix(requestId)}`;
  }

  const operationalError = new AppError(message, statusCode, {
    details: { operation, platformCode, platformMessage, requestId, httpStatus },
  });
  operationalError.cause = error;
  return operationalError;
};

const assertTikTokSuccess = (data, operation) => {
  if (data?.code !== 0) {
    throw toTikTokError(data, operation);
  }
  return data;
};

/**
 * Exchange the auth_code (TikTok Business API) for an access token.
 * TikTok Business API uses app_id/secret, not client_key/client_secret.
 */
export const exchangeCodeForToken = async (authCode) => {
  try {
    const { data } = await axios.post(
      `${TIKTOK_API_BASE}/oauth2/access_token/`,
      { app_id: APP_ID(), secret: APP_SECRET(), auth_code: authCode },
      { headers: { "Content-Type": "application/json" } }
    );

    assertTikTokSuccess(data, "token exchange");
    return data.data; // { access_token, advertiser_ids, scope, token_type }
  } catch (error) {
    throw toTikTokError(error, "token exchange");
  }
};

/**
 * Get the list of advertiser accounts associated with the access token.
 */
export const fetchAdvertiserList = async (accessToken) => {
  // TikTok's Business API reads the token ONLY from the Access-Token header —
  // an access_token query param is silently ignored, which is why this
  // endpoint reported "The access_token is empty" (code 40104) with a real,
  // valid token. fetchReport below already does this correctly.
  try {
    const { data } = await axios.get(`${TIKTOK_API_BASE}/oauth2/advertiser/get/`, {
      headers: { "Access-Token": accessToken },
      params: { app_id: APP_ID(), secret: APP_SECRET() },
    });

    assertTikTokSuccess(data, "advertiser list");
    return data.data?.list || [];
  } catch (error) {
    throw toTikTokError(error, "advertiser list");
  }
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
    let data;
    try {
      const response = await axios.get(`${TIKTOK_API_BASE}/report/integrated/get/`, {
        headers: { "Access-Token": accessToken },
        params: {
          advertiser_id: String(advertiserId),
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
      data = assertTikTokSuccess(response.data, `${dataLevel} report`);
    } catch (error) {
      throw toTikTokError(error, `${dataLevel} report`);
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
  "campaign_automation_type",
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
  "campaign_id",
  "campaign_name",
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
  "bid",
  "optimization_event",
  "placement_type",
  "budget",
];

const AD_METRICS = [
  "ad_name",
  "adgroup_id",
  "adgroup_name",
  "campaign_id",
  "campaign_name",
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

export const fetchCampaignReport = async (accessToken, advertiserId, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(accessToken, advertiserId, "AUCTION_CAMPAIGN", ["campaign_id"], CAMPAIGN_METRICS, start_date, end_date);
};

export const fetchAdGroupReport = async (accessToken, advertiserId, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(
    accessToken, advertiserId, "AUCTION_ADGROUP",
    ["adgroup_id"], ADGROUP_METRICS, start_date, end_date
  );
};

export const fetchAdReport = async (accessToken, advertiserId, daysBack = 30) => {
  const { start_date, end_date } = getDateRange(daysBack);
  return fetchReport(
    accessToken, advertiserId, "AUCTION_AD",
    ["ad_id"], AD_METRICS, start_date, end_date
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
