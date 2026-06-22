import axios from "axios";

const CLIENT_ID = () => process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET;
const CALLBACK_URL = () => process.env.GOOGLE_CALLBACK_URL;
const DEVELOPER_TOKEN = () => process.env.GOOGLE_DEVELOPER_TOKEN;
const LOGIN_CUSTOMER_ID = () => process.env.GOOGLE_LOGIN_CUSTOMER_ID || null;

const GOOGLE_ADS_VERSION = "v22";
const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`;

const dateFilter = (dateRange) => {
  // Numeric value: arbitrary lookback window using BETWEEN
  const days =
    typeof dateRange === "number" ? dateRange :
    dateRange === "LAST_90_DAYS" ? 90 :
    dateRange === "LAST_60_DAYS" ? 60 : null;
  if (days != null) {
    const fmt = (d) => d.toISOString().split("T")[0];
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    return `segments.date BETWEEN '${fmt(start)}' AND '${fmt(end)}'`;
  }
  return `segments.date DURING ${dateRange}`;
};

const buildHeaders = (accessToken, loginCustomerIdOverride = null) => {
  const devToken = DEVELOPER_TOKEN();
  if (!devToken) {
    throw new Error("GOOGLE_DEVELOPER_TOKEN is not set. Required for Google Ads API calls.");
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "developer-token": devToken,
    "Content-Type": "application/json",
  };
  const loginId = loginCustomerIdOverride || LOGIN_CUSTOMER_ID();
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
export const searchGoogleAds = async (accessToken, customerId, query, pageToken = null, loginCustomerId = null) => {
  const body = { query };
  if (pageToken) body.pageToken = pageToken;

  try {
    const { data } = await axios.post(
      `${GOOGLE_ADS_BASE}/customers/${customerId}/googleAds:search`,
      body,
      { headers: buildHeaders(accessToken, loginCustomerId) }
    );

    const results = data.results || [];
    if (data.nextPageToken) {
      const nextResults = await searchGoogleAds(accessToken, customerId, query, data.nextPageToken, loginCustomerId);
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
export const fetchCustomerInfo = async (accessToken, customerId, loginCustomerId = null) => {
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
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  const info = results[0]?.customer || null;
  console.log(`[Google Ads] Customer info:`, info);
  return info;
};

export const fetchManagerSubAccounts = async (accessToken, managerCustomerId) => {
  console.log(`[Google Ads] Fetching sub-accounts for manager ${managerCustomerId}...`);
  const query = `
    SELECT
      customer_client.client_customer,
      customer_client.descriptive_name,
      customer_client.currency_code,
      customer_client.time_zone,
      customer_client.manager,
      customer_client.status,
      customer_client.level
    FROM customer_client
    WHERE customer_client.manager = false
      AND customer_client.status = 'ENABLED'
  `;
  const results = await searchGoogleAds(accessToken, managerCustomerId, query, null, managerCustomerId);
  const accounts = results.map((r) => {
    const c = r.customerClient;
    return {
      id: c.clientCustomer.split("/")[1],
      name: c.descriptiveName || null,
      currencyCode: c.currencyCode,
      timeZone: c.timeZone,
    };
  });
  console.log(`[Google Ads] Found ${accounts.length} sub-account(s) under manager ${managerCustomerId}.`);
  return accounts;
};

/**
 * Fetch campaign-level metrics aggregated over the given date range.
 * dateRange: LAST_30_DAYS | LAST_90_DAYS (GAQL enum)
 */
export const fetchCampaignsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS", loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching campaigns for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.status,
      campaign.advertising_channel_type,
      campaign.bidding_strategy_type,
      campaign.target_cpa.target_cpa_micros,
      campaign.maximize_conversions.target_cpa_micros,
      campaign.target_roas.target_roas,
      campaign.maximize_conversion_value.target_roas,
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
      metrics.view_through_conversions,
      metrics.search_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share,
      metrics.search_top_impression_share,
      metrics.search_absolute_top_impression_share
    FROM campaign
    WHERE ${dateFilter(dateRange)}
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} campaign row(s) for ${dateRange}.`);
  return results;
};

/**
 * Fetch campaign-level ad extensions (assets) — sitelinks, callouts, structured
 * snippets, etc. Config only (no metrics), one row per campaign × asset link.
 * Powers GOOGLE-EXT-001 (missing extension coverage). Best-effort at call site.
 */
export const fetchCampaignAssets = async (accessToken, customerId, loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching campaign assets (extensions) for customer ${customerId}...`);
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign_asset.field_type,
      campaign_asset.status
    FROM campaign_asset
    WHERE campaign.status != 'REMOVED'
      AND campaign_asset.status != 'REMOVED'
    LIMIT 10000
  `;
  try {
    const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
    console.log(`[Google Ads] ✓ Fetched ${results.length} campaign asset row(s).`);
    return results;
  } catch (err) {
    console.warn(`[Google Ads] campaign assets unavailable for customer ${customerId}: ${err.message}`);
    return [];
  }
};

/**
 * Fetch conversion-action configuration (no metrics — config only, so the query
 * stays valid on every account). Tells us whether the account tracks
 * conversions at all, which actions are primary (what Smart Bidding optimizes
 * toward), and what each action measures. Powers GOOGLE-CONV-001
 * (conversion-tracking health). Best-effort at the call site.
 */
export const fetchConversionActions = async (accessToken, customerId, loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching conversion actions for customer ${customerId}...`);
  const query = `
    SELECT
      conversion_action.id,
      conversion_action.name,
      conversion_action.status,
      conversion_action.type,
      conversion_action.category,
      conversion_action.primary_for_goal,
      conversion_action.counting_type
    FROM conversion_action
    WHERE conversion_action.status != 'REMOVED'
    LIMIT 500
  `;
  try {
    const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
    console.log(`[Google Ads] ✓ Fetched ${results.length} conversion action(s).`);
    return results;
  } catch (err) {
    console.warn(`[Google Ads] conversion actions unavailable for customer ${customerId}: ${err.message}`);
    return [];
  }
};

/**
 * Fetch ad group-level metrics.
 */
export const fetchAdGroupsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS", loginCustomerId = null) => {
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
    WHERE ${dateFilter(dateRange)}
      AND ad_group.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} ad group row(s) for ${dateRange}.`);
  return results;
};

/**
 * Fetch ad-level metrics.
 */
export const fetchAdsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS", loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching ads for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad.ad_strength,
      ad_group_ad.status,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.conversions
    FROM ad_group_ad
    WHERE ${dateFilter(dateRange)}
      AND ad_group_ad.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} ad row(s) for ${dateRange}.`);
  return results;
};

/**
 * Fetch keyword-level metrics including match type and Quality Score.
 * Powers KW-007 (broad match share), KW-005 (low QS), and KW-003 (search term waste).
 */
export const fetchKeywordsWithMetrics = async (accessToken, customerId, dateRange = "LAST_30_DAYS", loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching keywords for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.status,
      ad_group_criterion.quality_info.quality_score,
      ad_group_criterion.quality_info.creative_quality_score,
      ad_group_criterion.quality_info.post_click_quality_score,
      ad_group_criterion.quality_info.search_predicted_ctr,
      ad_group_criterion.effective_cpc_bid_micros,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name,
      campaign.bidding_strategy_type,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.average_cpc,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM keyword_view
    WHERE ${dateFilter(dateRange)}
      AND ad_group_criterion.status != 'REMOVED'
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} keyword row(s) for ${dateRange}.`);
  return results;
};

/**
 * Fetch search term view — the actual queries users typed that triggered ads.
 * Powers KW-003 (high-spend zero-conversion terms).
 */
export const fetchSearchTerms = async (accessToken, customerId, loginCustomerId = null, dateRange = "LAST_30_DAYS") => {
  console.log(`[Google Ads] Fetching search terms for customer ${customerId}...`);
  const query = `
    SELECT
      search_term_view.search_term,
      search_term_view.status,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.ctr,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM search_term_view
    WHERE ${dateFilter(dateRange)}
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 10000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} search term row(s).`);
  return results;
};

/**
 * Fetch daily time series at the account level (segments.date).
 * Powers byDay trend analysis. Best-effort — caller tolerates failure.
 */
export const fetchDailySegments = async (accessToken, customerId, dateRange = "LAST_30_DAYS", loginCustomerId = null) => {
  const query = `
    SELECT
      segments.date,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM customer
    WHERE ${dateFilter(dateRange)}
    ORDER BY segments.date
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} daily segment row(s).`);
  return results;
};

/**
 * Fetch account-level segment breakdowns (device, day-of-week, ad network).
 * Each is an independent GAQL query FROM customer, so metrics aggregate at the
 * account level — one row per segment value. Powers per-segment waste analysis
 * (analyzeSegments + SEG-WASTE-001). Best-effort per dimension.
 */
export const fetchSegmentBreakdowns = async (
  accessToken,
  customerId,
  dateRange = "LAST_30_DAYS",
  loginCustomerId = null
) => {
  const metrics =
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value";
  const dimensions = [
    { key: "device", field: "segments.device" },
    { key: "dayOfWeek", field: "segments.day_of_week" },
    { key: "network", field: "segments.ad_network_type" },
  ];
  const out = {};
  for (const { key, field } of dimensions) {
    try {
      const query = `SELECT ${field}, ${metrics} FROM customer WHERE ${dateFilter(dateRange)}`;
      out[key] = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
      console.log(`[Google Ads] ✓ Fetched ${out[key].length} '${key}' segment row(s).`);
    } catch (err) {
      console.warn(`[Google Ads] segment breakdown '${key}' unavailable: ${err.message}`);
      out[key] = [];
    }
  }
  return out;
};

/**
 * Fetch negative keyword shared lists.
 * member_count and reference_count give the rule engine coverage signals for KW-002.
 */
export const fetchNegativeKeywordLists = async (accessToken, customerId, loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching negative keyword lists for customer ${customerId}...`);
  const query = `
    SELECT
      shared_set.id,
      shared_set.name,
      shared_set.type,
      shared_set.member_count,
      shared_set.reference_count,
      shared_set.status
    FROM shared_set
    WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
      AND shared_set.status != 'REMOVED'
    LIMIT 1000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} negative keyword list(s).`);
  return results;
};

/**
 * Fetch Performance Max asset group assets.
 * Returns asset type, performance label, and campaign context for PMax asset auditing.
 * Returns empty array if the account has no PMax campaigns.
 */
export const fetchPMaxAssets = async (accessToken, customerId, loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching PMax assets for customer ${customerId}...`);
  const query = `
    SELECT
      asset_group_asset.field_type,
      asset_group_asset.status,
      asset.id,
      asset.name,
      asset.type,
      asset_group.id,
      asset_group.name,
      asset_group.status,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type
    FROM asset_group_asset
    WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX'
      AND campaign.status != 'REMOVED'
      AND asset_group.status != 'REMOVED'
      AND asset_group_asset.status != 'REMOVED'
    LIMIT 5000
  `;
  try {
    const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
    console.log(`[Google Ads] ✓ Fetched ${results.length} PMax asset(s).`);
    return results;
  } catch (err) {
    console.warn(`[Google Ads] PMax assets unavailable for customer ${customerId}: ${err.message}`);
    return [];
  }
};

/**
 * Fetch Shopping product feed items from the linked Merchant Center.
 * Returns product status and issues for feed health auditing.
 * Returns empty array if the account has no Merchant Center linked — this is not an error.
 */
export const fetchShoppingProducts = async (accessToken, customerId, loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching shopping product feed for customer ${customerId}...`);
  const query = `
    SELECT
      shopping_product.resource_name,
      shopping_product.item_id,
      shopping_product.title,
      shopping_product.brand,
      shopping_product.status,
      shopping_product.issues
    FROM shopping_product
    LIMIT 5000
  `;
  try {
    const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
    console.log(`[Google Ads] ✓ Fetched ${results.length} shopping product(s).`);
    return results;
  } catch (err) {
    console.warn(`[Google Ads] Shopping feed unavailable for customer ${customerId} (no Merchant Center linked): ${err.message}`);
    return [];
  }
};

/**
 * Fetch audience observation/targeting criteria on ad groups (USER_LIST type).
 * Returns bid modifiers and performance metrics — powers AUD-006 (audience layer check).
 */
export const fetchAudienceBidding = async (accessToken, customerId, loginCustomerId = null) => {
  console.log(`[Google Ads] Fetching audience bidding criteria for customer ${customerId}...`);
  const query = `
    SELECT
      ad_group_criterion.criterion_id,
      ad_group_criterion.type,
      ad_group_criterion.user_list.user_list,
      ad_group_criterion.bid_modifier,
      ad_group_criterion.status,
      ad_group.id,
      ad_group.name,
      campaign.id,
      campaign.name
    FROM ad_group_criterion
    WHERE ad_group_criterion.type = 'USER_LIST'
      AND ad_group_criterion.status != 'REMOVED'
    LIMIT 5000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} audience criterion row(s).`);
  return results;
};

/**
 * Fetch per-campaign audience PERFORMANCE (spend, conversions, CPA by audience
 * segment). Unlike fetchAudienceBidding (bid modifiers only), this carries the
 * metrics needed to detect a mis-applied audience — the same segment running at
 * a healthy CPA in one campaign and a catastrophic CPA in another. Reports one
 * row per campaign × ad group × audience criterion. Powers GOOGLE-AUD-001.
 *
 * Conservative SELECT (criterion_id is the cross-campaign join key; no
 * display_name, which is not reliably selectable from this view) so the query
 * stays valid across accounts. Best-effort at the call site.
 */
export const fetchAudiencePerformance = async (
  accessToken,
  customerId,
  dateRange = "LAST_30_DAYS",
  loginCustomerId = null
) => {
  console.log(`[Google Ads] Fetching audience performance for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_criterion.criterion_id,
      ad_group_criterion.type,
      ad_group_criterion.user_list.user_list,
      ad_group_criterion.custom_audience.custom_audience,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_per_conversion
    FROM ad_group_audience_view
    WHERE ${dateFilter(dateRange)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 5000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} audience performance row(s).`);
  return results;
};

/**
 * Fetch per-campaign DEVICE performance (segments.device FROM campaign — not the
 * account-level breakdown used by fetchSegmentBreakdowns). Resolves device waste
 * inside a specific campaign, e.g. desktop generating clicks but zero
 * conversions. Powers GOOGLE-DEVICE-001.
 */
export const fetchCampaignDeviceBreakdown = async (
  accessToken,
  customerId,
  dateRange = "LAST_30_DAYS",
  loginCustomerId = null
) => {
  console.log(`[Google Ads] Fetching campaign×device breakdown for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      campaign.id,
      campaign.name,
      segments.device,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE ${dateFilter(dateRange)}
      AND campaign.status != 'REMOVED'
    ORDER BY metrics.cost_micros DESC
    LIMIT 5000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} campaign×device row(s).`);
  return results;
};

/**
 * Fetch landing-page PERFORMANCE by final URL (landing_page_view). The
 * unexpanded_final_url is human-readable, so no resolution needed. Powers
 * GOOGLE-LP-001 (CVR divergence across landing pages / domains).
 */
export const fetchLandingPagePerformance = async (
  accessToken,
  customerId,
  dateRange = "LAST_30_DAYS",
  loginCustomerId = null
) => {
  console.log(`[Google Ads] Fetching landing page performance for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      landing_page_view.unexpanded_final_url,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM landing_page_view
    WHERE ${dateFilter(dateRange)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 2000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} landing page row(s).`);
  return results;
};

/**
 * Fetch GEO performance by country (geographic_view). Country comes back as a
 * numeric geo-target-constant id; resolveGeoTargetNames turns it into a country
 * name. location_type distinguishes physical presence vs location of interest.
 * Powers GOOGLE-GEO-001 (spend leaking to under-performing markets).
 */
export const fetchGeoPerformance = async (
  accessToken,
  customerId,
  dateRange = "LAST_30_DAYS",
  loginCustomerId = null
) => {
  console.log(`[Google Ads] Fetching geo performance for customer ${customerId} (${dateRange})...`);
  const query = `
    SELECT
      campaign.name,
      geographic_view.country_criterion_id,
      geographic_view.location_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value
    FROM geographic_view
    WHERE ${dateFilter(dateRange)}
    ORDER BY metrics.cost_micros DESC
    LIMIT 5000
  `;
  const results = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  console.log(`[Google Ads] ✓ Fetched ${results.length} geo row(s).`);
  return results;
};

/**
 * Resolve audience criterion resources to readable names. The
 * ad_group_audience_view does not reliably expose an audience's display name, so
 * a finding can only show its numeric criterion id ("Custom audience #2488…").
 * This batches the user-list and custom-audience resources behind those ids into
 * one lookup each and returns a { resourceName → name } map. Best-effort and
 * fault-isolated: if either lookup fails the caller falls back to the id label.
 *
 * @param {object} resources { userListResources: string[], customAudienceResources: string[] }
 * @returns {Promise<Record<string,string>>} resourceName → display name
 */
export const resolveAudienceNames = async (
  accessToken,
  customerId,
  { userListResources = [], customAudienceResources = [] } = {},
  loginCustomerId = null
) => {
  const map = {};
  const idOf = (resource) => String(resource || "").split("/").pop();

  const userListIds = [...new Set((userListResources || []).map(idOf).filter(Boolean))];
  if (userListIds.length) {
    try {
      const inList = userListIds.map((id) => `'${id}'`).join(", ");
      const rows = await searchGoogleAds(
        accessToken,
        customerId,
        `SELECT user_list.id, user_list.name, user_list.resource_name FROM user_list WHERE user_list.id IN (${inList})`,
        null,
        loginCustomerId
      );
      for (const row of rows) {
        const name = row.userList?.name;
        if (name && row.userList?.resourceName) map[row.userList.resourceName] = name;
      }
    } catch (err) {
      console.warn(`[Google Ads] user-list name resolution failed (non-fatal): ${err.message}`);
    }
  }

  const customIds = [...new Set((customAudienceResources || []).map(idOf).filter(Boolean))];
  if (customIds.length) {
    try {
      const inList = customIds.map((id) => `'${id}'`).join(", ");
      const rows = await searchGoogleAds(
        accessToken,
        customerId,
        `SELECT custom_audience.id, custom_audience.name, custom_audience.resource_name FROM custom_audience WHERE custom_audience.id IN (${inList})`,
        null,
        loginCustomerId
      );
      for (const row of rows) {
        const name = row.customAudience?.name;
        if (name && row.customAudience?.resourceName) map[row.customAudience.resourceName] = name;
      }
    } catch (err) {
      console.warn(`[Google Ads] custom-audience name resolution failed (non-fatal): ${err.message}`);
    }
  }

  return map;
};

/**
 * Resolve geo-target-constant ids (e.g. "2586") to readable country names
 * (e.g. "Pakistan"). Batched into one GAQL query. Returns a { id → name } map;
 * unresolved ids are simply absent (the normalizer falls back to the raw id).
 */
export const resolveGeoTargetNames = async (
  accessToken,
  customerId,
  ids = [],
  loginCustomerId = null
) => {
  const unique = [...new Set((ids || []).filter((id) => id != null).map(String))];
  if (unique.length === 0) return {};
  const inList = unique.map((id) => `'${id}'`).join(", ");
  const query = `
    SELECT
      geo_target_constant.id,
      geo_target_constant.name,
      geo_target_constant.country_code
    FROM geo_target_constant
    WHERE geo_target_constant.id IN (${inList})
  `;
  const rows = await searchGoogleAds(accessToken, customerId, query, null, loginCustomerId);
  const map = {};
  for (const row of rows) {
    const id = row.geoTargetConstant?.id;
    if (id != null) {
      map[String(id)] = {
        name: row.geoTargetConstant?.name || String(id),
        countryCode: row.geoTargetConstant?.countryCode || null,
      };
    }
  }
  return map;
};
