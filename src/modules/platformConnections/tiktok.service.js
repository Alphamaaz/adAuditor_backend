import axios from "axios";

const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

const CLIENT_KEY = () => process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = () => process.env.TIKTOK_CLIENT_SECRET;

/**
 * Exchange the auth code for an access token using TikTok Login Kit v2.
 */
export const exchangeCodeForToken = async (code) => {
  const params = new URLSearchParams();
  params.append("client_key", CLIENT_KEY());
  params.append("client_secret", CLIENT_SECRET());
  params.append("code", code);
  params.append("grant_type", "authorization_code");
  params.append("redirect_uri", process.env.TIKTOK_CALLBACK_URL);

  const { data } = await axios.post("https://open.tiktokapis.com/v2/oauth/token/", params, {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (data.error) {
    throw new Error(`TikTok Auth Error: ${data.error_description} (${data.error})`);
  }

  return data; // { access_token, refresh_token, expires_in, open_id, ... }
};

/**
 * Get the list of ad accounts this user has access to.
 */
export const fetchAdAccounts = async (accessToken) => {
  const { data } = await axios.get(`${TIKTOK_API_BASE}/ad_account/get/`, {
    headers: {
      "Access-Token": accessToken,
    },
  });

  if (data.code !== 0) {
    throw new Error(`TikTok API Error: ${data.message} (Code: ${data.code})`);
  }

  return data.data.list || []; // Array of { ad_account_id, ad_account_name, ... }
};

/**
 * Fetch campaign-level insights from TikTok.
 */
export const fetchCampaignInsights = async (accessToken, advertiserId, dateRange) => {
  const { data } = await axios.get(`${TIKTOK_API_BASE}/report/integrated/get/`, {
    headers: {
      "Access-Token": accessToken,
    },
    params: {
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: "AUCTION_CAMPAIGN",
      dimensions: ["campaign_id"],
      metrics: [
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
        "cpm"
      ],
      start_date: dateRange.start,
      end_date: dateRange.end,
      page_size: 100,
    },
  });

  if (data.code !== 0) {
    throw new Error(`TikTok API Error: ${data.message} (Code: ${data.code})`);
  }

  return data.data.list || [];
};
