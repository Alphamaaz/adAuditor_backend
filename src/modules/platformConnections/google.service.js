import axios from "axios";

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET;
const CALLBACK_URL = () => process.env.GOOGLE_CALLBACK_URL;
const DEVELOPER_TOKEN = () => process.env.GOOGLE_DEVELOPER_TOKEN;
const LOGIN_CUSTOMER_ID = () => process.env.GOOGLE_LOGIN_CUSTOMER_ID || null;

const GOOGLE_ADS_VERSION = "v18";
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`;

const buildHeaders = (accessToken) => {
  const devToken = DEVELOPER_TOKEN();
  if (!devToken) {
    throw new Error("GOOGLE_DEVELOPER_TOKEN is not set. Required for Google Ads API calls.");
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": devToken,
    "Content-Type": "application/json",
  };
  const loginId = LOGIN_CUSTOMER_ID();
  if (loginId) headers["login-customer-id"] = loginId;
  return headers;
};

/**
 * Extract a human-readable error from a Google Ads API axios error.
 * Google nests the real message inside error.details[].errors[].message
 */
const extractGoogleError = (err) => {
  const body = err?.response?.data;
  const status = err?.response?.status;

  console.error(`[Google Ads] HTTP ${status} error from Google API:`);
  console.error(JSON.stringify(body, null, 2));

  const googleErrors = body?.error?.details?.[0]?.errors;
  if (googleErrors?.length) {
    const codes = googleErrors.map((e) => Object.values(e.errorCode || {})[0]).filter(Boolean);
    const messages = googleErrors.map((e) => e.message).filter(Boolean);
    return `Google Ads API error [${codes.join(", ")}]: ${messages.join("; ")}`;
  }

  return body?.error?.message || err.message || "Unknown Google Ads API error";
};

/**
 * Exchange auth code for access + refresh tokens.
 */
export const exchangeCodeForToken = async (code) => {
  const { data } = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    code,
    grant_type: "authorization_code",
    redirect_uri: CALLBACK_URL(),
  });

  if (data.error) {
    throw new Error(`Google Auth Error: ${data.error_description} (${data.error})`);
  }

  return data; // { access_token, refresh_token, expires_in, scope, token_type, id_token }
};

/**
 * Use a refresh token to obtain a new access token.
 * Returns: { access_token, expires_in, token_type }
 */
export const refreshAccessToken = async (refreshToken) => {
  const { data } = await axios.post("https://oauth2.googleapis.com/token", {
    client_id: CLIENT_ID(),
    client_secret: CLIENT_SECRET(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  if (data.error) {
    throw new Error(`Google Token Refresh Error: ${data.error_description} (${data.error})`);
  }

  return data;
};

/**
 * List all Google Ads customer accounts accessible to the authenticated user.
 * Returns array of resource names: ["customers/1234567890", ...]
 */
export const fetchAccessibleCustomers = async (accessToken) => {
  console.log("[Google Ads] Fetching accessible customer accounts...");
  try {
    const { data } = await axios.get(
      `${GOOGLE_ADS_BASE}/customers:listAccessibleCustomers`,
      { headers: buildHeaders(accessToken) }
    );
    const resourceNames = data.resourceNames || [];
    console.log(`[Google Ads] Found ${resourceNames.length} accessible customer(s):`, resourceNames);
    return resourceNames;
  } catch (err) {
    throw new Error(extractGoogleError(err));
  }
};

/**
 * Execute a GAQL query. Handles pagination automatically.
 */
export const searchGoogleAds = async (accessToken, customerId, query, pageToken = null) => {
  const body = { query };
  if (pageToken) body.pageToken = pageToken;

  try {
    const { data } = await axios.post(
      `${GOOGLE_ADS_BASE}/customers/${customerId}/googleAds:search`,
      body,
      { headers: buildHeaders(accessToken) }
    );

    const results = data.results || [];
    if (data.nextPageToken) {
      const nextResults = await searchGoogleAds(accessToken, customerId, query, data.nextPageToken);
      return [...results, ...nextResults];
    }
    return results;
  } catch (err) {
    throw new Error(extractGoogleError(err));
  }
};

/**
 * Fetch basic customer/account info (name, currency, timezone).
 */
export const fetchCustomerInfo = async (accessToken, customerId) => {
  console.log(`[Google Ads] Fetching customer info for ${customerId}...`);
  const query = `
    SELECT
      customer.id,
      customer.descriptive_name,
      customer.currency_code,
      customer.time_zone,
      customer.status,
      customer.manager
    FROM customer
    LIMIT 1
  `;
  const results = await searchGoogleAds(accessToken, customerId, query);
  const info = results[0]?.customer || null;
  console.log(`[Google Ads] Customer info:`, info);
  return info;
};

/**
 * Fetch campaign-level metrics aggregated over the given date range.
 * dateRange: LAST_30_DAYS | LAST_90_DAYS (GAQL enum)
 */
export const fetchCampaignsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS") => {
  console.log(`[Google Ads] Fetching campaigns for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign_budget.amount_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.average_cpc,
      metrics.average_cpm,
      metrics.conversions,
      metrics.cost_per_conversion,
      metrics.all_conversions_value,
      metrics.view_through_conversions
    FROM campaign
    WHERE segments.date DURING ${dateRange}
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query);
  console.log(`[Google Ads] ✓ Fetched ${results.length} campaign row(s) for ${dateRange}.`);
  return results;
};

/**
 * Fetch ad group-level metrics.
 */
export const fetchAdGroupsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS") => {
  console.log(`[Google Ads] Fetching ad groups for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      ad_group.id,
      ad_group.name,
      ad_group.status,
      ad_group.type,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.average_cpc,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM ad_group
    WHERE segments.date DURING ${dateRange}
      AND ad_group.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query);
  console.log(`[Google Ads] ✓ Fetched ${results.length} ad group row(s) for ${dateRange}.`);
  return results;
};

/**
 * Fetch ad-level metrics.
 */
export const fetchAdsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS") => {
  console.log(`[Google Ads] Fetching ads for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad.status,
      ad_group.name,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.conversions
    FROM ad_group_ad
    WHERE segments.date DURING ${dateRange}
      AND ad_group_ad.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query);
  console.log(`[Google Ads] ✓ Fetched ${results.length} ad row(s) for ${dateRange}.`);
  return results;
};
