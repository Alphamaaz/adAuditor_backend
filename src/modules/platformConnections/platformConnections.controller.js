import crypto from "crypto";
import { prisma } from "../../lib/prisma.js";
import { getOrganizationId } from "../../utils/requestContext.js";
import { badRequest, notFound } from "../../utils/appError.js";
import { encrypt, decrypt } from "../../utils/tokenEncryption.js";
import {
  exchangeCodeForToken,
  getLongLivedToken,
  debugToken,
  fetchAdAccounts,
  fetchCampaignInsights,
  fetchAdSetInsights,
  fetchAdInsights,
  fetchCampaigns,
  fetchAdSets,
  fetchAds,
  fetchBreakdownInsights,
  fetchDailyInsights,
  META_BREAKDOWNS,
} from "./meta.service.js";
import {
  normalizeCampaignInsights,
  normalizeAdSetInsights,
  normalizeAdInsights,
  enrichCampaignsWithStructure,
  enrichAdSetsWithStructure,
  enrichAdsWithStructure,
  buildMetaNormalizedDataset,
  normalizeBreakdownInsights,
  normalizeDailyInsights,
} from "./metaNormalizer.service.js";
import {
  exchangeCodeForToken as exchangeTikTokCode,
  fetchAdvertiserList as fetchTikTokAdvertiserList,
  fetchCampaignReport as fetchTikTokCampaigns,
  fetchAdGroupReport as fetchTikTokAdGroups,
  fetchAdReport as fetchTikTokAds,
} from "./tiktok.service.js";
import {
  normalizeCampaigns as normalizeTikTokCampaigns,
  normalizeAdGroups as normalizeTikTokAdGroups,
  normalizeAds as normalizeTikTokAds,
  buildTikTokNormalizedDataset,
} from "./tiktokNormalizer.service.js";
import {
  exchangeCodeForToken as exchangeGoogleCode,
  refreshAccessToken as refreshGoogleToken,
  fetchAccessibleCustomers,
  fetchCustomerInfo,
  fetchManagerSubAccounts,
  fetchCampaignsWithMetrics,
  fetchAdGroupsWithMetrics,
  fetchAdsWithMetrics,
  fetchKeywordsWithMetrics,
  fetchSearchTerms,
  fetchDailySegments,
  fetchSegmentBreakdowns,
  fetchNegativeKeywordLists,
  fetchPMaxAssets,
  fetchShoppingProducts,
  fetchAudienceBidding,
} from "./google.service.js";
import {
  normalizeCampaigns,
  normalizeAdGroups,
  normalizeAds,
  normalizeKeywords,
  normalizeSearchTerms,
  normalizeNegativeKeywordLists,
  normalizePMaxAssets,
  normalizeShoppingProducts,
  normalizeAudienceBidding,
  normalizeGoogleDailySegments,
  buildGoogleByDimension,
  buildGoogleNormalizedDataset,
} from "./googleNormalizer.service.js";

const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL ||
  "http://localhost:5000/api/platform-connections/google/callback";


const META_CALLBACK_URL =
  process.env.META_CALLBACK_URL ||
  "http://localhost:5000/api/platform-connections/meta/callback";

// ── OAuth handshake ──────────────────────────────────────────────────────────

/**
 * Step 1: Redirect the user to Meta's authorization dialog.
 * The `state` param ties the OAuth session back to this user/org.
 *
 * GET /api/platform-connections/meta/connect?auditId=...
 */
export const initMetaOAuth = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { auditId } = req.query;

  // Encode org + optional audit into state so the callback can restore context
  const statePayload = JSON.stringify({ organizationId, auditId: auditId || null });
  const state = Buffer.from(statePayload).toString("base64url");

  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: META_CALLBACK_URL,
    state,
    scope: "ads_read,business_management",
    response_type: "code",
  });

  const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?${params.toString()}`;
  res.redirect(authUrl);
};

/**
 * Step 2: Meta redirects back here with a code.
 * We exchange it for a long-lived token and store it encrypted.
 *
 * GET /api/platform-connections/meta/callback?code=...&state=...
 */
export const metaOAuthCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;

  const FRONTEND_BASE = process.env.CLIENT_ORIGIN || "http://localhost:3000";

  if (error) {
    const message = encodeURIComponent(error_description || error);
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=${message}&platform=META`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=missing_code&platform=META`);
  }

  let organizationId;
  let auditId;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
    organizationId = decoded.organizationId;
    auditId = decoded.auditId;
  } catch {
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=invalid_state&platform=META`);
  }

  try {
    // Exchange code → short-lived token
    const shortTokenData = await exchangeCodeForToken(code, META_CALLBACK_URL);
    // Exchange short-lived → long-lived token (60 days)
    const longTokenData = await getLongLivedToken(shortTokenData.access_token);
    const accessToken = longTokenData.access_token;
    const expiresIn = longTokenData.expires_in || 5183944; // ~60 days in seconds

    // Verify the token and get user_id from Meta
    const tokenInfo = await debugToken(accessToken);
    if (!tokenInfo.is_valid) {
      return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=invalid_token&platform=META`);
    }

    const encryptedToken = encrypt(accessToken);
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    // PlatformConnection has no unique constraint on (organizationId, platform),
    // so we use findFirst + create/update instead of upsert.
    const existingConnection = await prisma.platformConnection.findFirst({
      where: { organizationId, platform: "META" },
      select: { id: true },
    });

    if (existingConnection) {
      await prisma.platformConnection.update({
        where: { id: existingConnection.id },
        data: {
          status: "ACTIVE",
          externalAccountId: tokenInfo.user_id || null,
          accessTokenEncrypted: encryptedToken,
          tokenExpiresAt,
          scopes: tokenInfo.scopes || ["ads_read", "business_management"],
          metadata: { debugInfo: tokenInfo },
        },
      });
    } else {
      await prisma.platformConnection.create({
        data: {
          organizationId,
          platform: "META",
          externalAccountId: tokenInfo.user_id || null,
          status: "ACTIVE",
          accessTokenEncrypted: encryptedToken,
          tokenExpiresAt,
          scopes: tokenInfo.scopes || ["ads_read", "business_management"],
          metadata: { debugInfo: tokenInfo },
        },
      });
    }

    // Redirect to frontend with success signal
    const successUrl = auditId
      ? `${FRONTEND_BASE}/dashboard/audits/${auditId}/connect?platform=META&connected=true`
      : `${FRONTEND_BASE}/dashboard?platform=META&connected=true`;

    return res.redirect(successUrl);
  } catch (err) {
    console.error("[Meta OAuth Callback Error]", err.message);
    const errMsg = encodeURIComponent("Failed to complete Meta connection. Please try again.");
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=${errMsg}&platform=META`);
  }
};

// ── TikTok OAuth flow ────────────────────────────────────────────────────────

/**
 * Step 1: Redirect the user to TikTok's authorization dialog.
 * GET /api/platform-connections/tiktok/connect
 */
export const initTikTokOAuth = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { auditId } = req.query;

  const statePayload = JSON.stringify({ organizationId, auditId: auditId || null });
  const state = Buffer.from(statePayload).toString("base64url");

  const params = new URLSearchParams({
    app_id: process.env.TIKTOK_APP_ID,
    state,
    redirect_uri: process.env.TIKTOK_CALLBACK_URL,
  });

  // TikTok Business API authorization URL (not the Login Kit URL)
  const authUrl = `https://business-api.tiktok.com/portal/auth?${params.toString()}`;
  res.redirect(authUrl);
};

/**
 * Step 2: TikTok redirects back with a code.
 */
export const tikTokOAuthCallback = async (req, res) => {
  // TikTok Business API sends auth_code (not code)
  const { auth_code, state, error, error_description } = req.query;
  const FRONTEND_BASE = process.env.CLIENT_ORIGIN || "http://localhost:3000";

  if (error || !auth_code || !state) {
    const msg = encodeURIComponent(error_description || "Missing OAuth auth_code");
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=${msg}&platform=TIKTOK`);
  }

  let organizationId;
  let auditId;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
    organizationId = decoded.organizationId;
    auditId = decoded.auditId;
  } catch {
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=invalid_state&platform=TIKTOK`);
  }

  try {
    // Business API token exchange — no refresh token, token is session-based
    const tokenData = await exchangeTikTokCode(auth_code);
    const accessToken = tokenData.access_token;
    const advertiserIds = tokenData.advertiser_ids || [];
    const scopes = Array.isArray(tokenData.scope)
      ? tokenData.scope
      : (tokenData.scope || "").split(",").map((s) => s.trim()).filter(Boolean);

    const encryptedToken = encrypt(accessToken);

    const existingConnection = await prisma.platformConnection.findFirst({
      where: { organizationId, platform: "TIKTOK" },
    });

    const connectionData = {
      status: "ACTIVE",
      accessTokenEncrypted: encryptedToken,
      refreshTokenEncrypted: null,
      tokenExpiresAt: null, // Business API tokens don't expire like Login Kit
      scopes: scopes.length > 0 ? scopes : ["ad_account_management"],
      metadata: { advertiser_ids: advertiserIds },
    };

    if (existingConnection) {
      await prisma.platformConnection.update({
        where: { id: existingConnection.id },
        data: connectionData,
      });
    } else {
      await prisma.platformConnection.create({
        data: { ...connectionData, organizationId, platform: "TIKTOK" },
      });
    }

    const successUrl = auditId
      ? `${FRONTEND_BASE}/dashboard/audits/${auditId}/connect?platform=TIKTOK&connected=true`
      : `${FRONTEND_BASE}/dashboard?platform=TIKTOK&connected=true`;

    return res.redirect(successUrl);
  } catch (err) {
    console.error("[TikTok OAuth Callback Error]", err.message);
    const msg = encodeURIComponent("Failed to complete TikTok connection. Please try again.");
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=${msg}&platform=TIKTOK`);
  }
};

// ── TikTok data endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/platform-connections/tiktok/ad-accounts
 * Lists the TikTok advertiser accounts the connected user has access to.
 */
export const listTikTokAdAccounts = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const connection = await prisma.platformConnection.findFirst({
    where: { organizationId, platform: "TIKTOK", status: "ACTIVE" },
  });

  if (!connection || !connection.accessTokenEncrypted) {
    throw notFound("No active TikTok connection found. Please connect your TikTok account first.");
  }

  const accessToken = decrypt(connection.accessTokenEncrypted);
  const advertisers = await fetchTikTokAdvertiserList(accessToken);

  res.json({
    status: "success",
    data: advertisers.map((a) => ({
      advertiserId: String(a.advertiser_id),
      name: a.advertiser_name || String(a.advertiser_id),
      currency: a.currency || null,
      timezone: a.timezone || null,
    })),
  });
};

/**
 * POST /api/platform-connections/tiktok/fetch-data
 * Fetches all TikTok Ads data for an audit and stores it as a NormalizedDataset.
 * Body: { auditId, advertiserId }
 */
export const fetchTikTokDataForAudit = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { auditId, advertiserId } = req.body;

  if (!auditId || !advertiserId) {
    throw badRequest("auditId and advertiserId are required.");
  }

  console.log(`\n[TikTok Ads] ═══ Starting data fetch ═══`);
  console.log(`[TikTok Ads] Org: ${organizationId} | Audit: ${auditId} | Advertiser: ${advertiserId}`);

  const [audit, connection] = await Promise.all([
    prisma.audit.findFirst({
      where: { id: auditId, organizationId },
      include: { normalizedDataset: true },
    }),
    prisma.platformConnection.findFirst({
      where: { organizationId, platform: "TIKTOK", status: "ACTIVE" },
    }),
  ]);

  if (!audit) throw notFound("Audit not found.");
  if (!connection || !connection.accessTokenEncrypted) {
    throw notFound("No active TikTok connection found. Connect your TikTok account first.");
  }
  if (!audit.selectedPlatforms.includes("TIKTOK")) {
    throw badRequest("This audit does not include TIKTOK as a selected platform.");
  }

  const accessToken = decrypt(connection.accessTokenEncrypted);

  console.log("[TikTok Ads] Fetching campaigns, ad groups, and ads in parallel...");
  const [rawCampaigns30d, rawAdGroups30d, rawAds30d, rawCampaigns90d] = await Promise.all([
    fetchTikTokCampaigns(accessToken, advertiserId, 30),
    fetchTikTokAdGroups(accessToken, advertiserId, 30),
    fetchTikTokAds(accessToken, advertiserId, 30),
    fetchTikTokCampaigns(accessToken, advertiserId, 90),
  ]);

  console.log("[TikTok Ads] Normalizing data...");
  const campaigns = normalizeTikTokCampaigns(rawCampaigns30d);
  const adGroups = normalizeTikTokAdGroups(rawAdGroups30d);
  const ads = normalizeTikTokAds(rawAds30d);
  const campaigns90d = normalizeTikTokCampaigns(rawCampaigns90d);

  console.log(
    `[TikTok Ads] Normalized: ${campaigns.length} campaigns, ${adGroups.length} ad groups, ${ads.length} ads`
  );

  // Find the advertiser's currency from the advertiser list
  let currency = null;
  try {
    const advertisers = await fetchTikTokAdvertiserList(accessToken);
    const advertiser = advertisers.find((a) => String(a.advertiser_id) === String(advertiserId));
    currency = advertiser?.currency || null;
  } catch {
    // currency stays null — non-critical
  }

  const tiktokDataset = buildTikTokNormalizedDataset({ campaignRecords: campaigns, adGroupRecords: adGroups, adRecords: ads, currency });
  tiktokDataset.data.platforms.TIKTOK.byLevel.campaign_90d = campaigns90d;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.normalizedDataset.findUnique({ where: { auditId } });

    let mergedData, mergedSummary;
    if (existing) {
      mergedData = {
        ...existing.data,
        platforms: { ...(existing.data?.platforms || {}), TIKTOK: tiktokDataset.data.platforms.TIKTOK },
      };
      mergedSummary = {
        ...existing.summary,
        platforms: { ...(existing.summary?.platforms || {}), TIKTOK: tiktokDataset.summary.platforms.TIKTOK },
        totals: tiktokDataset.summary.totals,
      };
    } else {
      mergedData = tiktokDataset.data;
      mergedSummary = tiktokDataset.summary;
    }

    await tx.normalizedDataset.upsert({
      where: { auditId },
      create: { auditId, data: mergedData, summary: mergedSummary },
      update: { data: mergedData, summary: mergedSummary },
    });

    await tx.audit.update({
      where: { id: auditId },
      data: { status: "VALIDATING", dataSource: "OAUTH" },
    });

    await tx.platformConnection.update({
      where: { id: connection.id },
      data: {
        externalAccountId: String(advertiserId),
        metadata: {
          ...(connection.metadata || {}),
          advertiserId: String(advertiserId),
          lastFetchedAt: new Date().toISOString(),
          currency,
        },
      },
    });

    await tx.auditEvent.create({
      data: {
        auditId,
        type: "OAUTH_DATA_FETCHED",
        message: "TikTok Ads data fetched via OAuth and normalized successfully.",
        metadata: { platform: "TIKTOK", advertiserId, summary: tiktokDataset.summary.platforms.TIKTOK },
      },
    });
  });

  const summaryOut = tiktokDataset.summary.platforms.TIKTOK;
  console.log("[TikTok Ads] ✓ Data stored. Summary:", summaryOut);
  console.log(`[TikTok Ads] ═══ Data fetch complete ═══\n`);

  res.json({
    status: "success",
    data: {
      auditId,
      platform: "TIKTOK",
      advertiserId,
      currency,
      summary: summaryOut,
      message: "TikTok Ads data fetched and normalized. You can now run the audit.",
    },
  });
};

// ── Connection management ────────────────────────────────────────────────────

/**
 * GET /api/platform-connections
 * Returns all connections for the current organization.
 */
export const listConnections = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const connections = await prisma.platformConnection.findMany({
    where: { organizationId },
    select: {
      id: true,
      platform: true,
      status: true,
      externalAccountId: true,
      tokenExpiresAt: true,
      scopes: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  res.json({ status: "success", data: connections });
};

/**
 * GET /api/platform-connections/meta/ad-accounts
 * Lists the Meta ad accounts the connected user has access to.
 */
export const listMetaAdAccounts = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const connection = await prisma.platformConnection.findFirst({
    where: { organizationId, platform: "META", status: "ACTIVE" },
  });

  if (!connection || !connection.accessTokenEncrypted) {
    throw notFound("No active Meta connection found. Please connect your Meta account first.");
  }

  const accessToken = decrypt(connection.accessTokenEncrypted);
  const adAccounts = await fetchAdAccounts(accessToken);

  res.json({
    status: "success",
    data: adAccounts.map((account) => ({
      id: account.id,
      accountId: account.account_id,
      name: account.name,
      currency: account.currency,
      status: account.account_status,
      businessName: account.business?.name || null,
    })),
  });
};

/**
 * POST /api/platform-connections/meta/fetch-data
 * Fetches all required Meta data for an audit and stores it as a NormalizedDataset.
 * Body: { auditId, externalAdAccountId }
 */
export const fetchMetaDataForAudit = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { auditId, externalAdAccountId } = req.body;

  if (!auditId || !externalAdAccountId) {
    throw badRequest("auditId and externalAdAccountId are required.");
  }

  const [audit, connection] = await Promise.all([
    prisma.audit.findFirst({
      where: { id: auditId, organizationId },
      include: { normalizedDataset: true },
    }),
    prisma.platformConnection.findFirst({
      where: { organizationId, platform: "META", status: "ACTIVE" },
    }),
  ]);

  if (!audit) throw notFound("Audit not found.");
  if (!connection || !connection.accessTokenEncrypted) {
    throw notFound("No active Meta connection found. Connect your Meta account first.");
  }
  if (!audit.selectedPlatforms.includes("META")) {
    throw badRequest("This audit does not include META as a selected platform.");
  }

  const accessToken = decrypt(connection.accessTokenEncrypted);

  // The Meta ad account ID from their API is prefixed with "act_"
  const adAccountId = externalAdAccountId.startsWith("act_")
    ? externalAdAccountId
    : `act_${externalAdAccountId}`;
  const plainAdAccountId = adAccountId.replace(/^act_/, "");

  let currency = null;
  try {
    const adAccounts = await fetchAdAccounts(accessToken);
    const selectedAccount = adAccounts.find(
      (account) =>
        String(account.id) === adAccountId ||
        String(account.account_id) === plainAdAccountId
    );
    currency = selectedAccount?.currency || null;
  } catch {
    currency = null;
  }

  // Fetch insights + structure data in parallel
  const [
    campaignInsights30d,
    adSetInsights30d,
    adInsights30d,
    campaignStructure,
    adSetStructure,
    adStructure,
    campaignInsights90d,
  ] = await Promise.all([
    fetchCampaignInsights(accessToken, adAccountId, "last_30d"),
    fetchAdSetInsights(accessToken, adAccountId, "last_30d"),
    fetchAdInsights(accessToken, adAccountId, "last_30d"),
    fetchCampaigns(accessToken, adAccountId),
    fetchAdSets(accessToken, adAccountId),
    fetchAds(accessToken, adAccountId),
    fetchCampaignInsights(accessToken, adAccountId, "last_90d"),
  ]);

  // Normalize + enrich with structural data
  const campaigns = enrichCampaignsWithStructure(
    normalizeCampaignInsights(campaignInsights30d),
    campaignStructure
  );
  const adSets = enrichAdSetsWithStructure(
    normalizeAdSetInsights(adSetInsights30d),
    adSetStructure
  );
  const ads = enrichAdsWithStructure(
    normalizeAdInsights(adInsights30d),
    adStructure
  );
  const campaigns90d = normalizeCampaignInsights(campaignInsights90d);

  // Fetch dimension breakdowns + daily series — BEST-EFFORT. Some accounts or
  // dimensions return errors (permissions, no data); none of that may fail the
  // audit, so we use allSettled and silently drop failures.
  const breakdownKeys = Object.keys(META_BREAKDOWNS);
  const [breakdownResults, dailyResult] = await Promise.all([
    Promise.allSettled(
      breakdownKeys.map((key) =>
        fetchBreakdownInsights(accessToken, adAccountId, key, "last_30d")
      )
    ),
    Promise.allSettled([
      fetchDailyInsights(accessToken, adAccountId, "last_30d"),
    ]),
  ]);

  const byDimension = {};
  breakdownResults.forEach((res, index) => {
    if (res.status !== "fulfilled" || !Array.isArray(res.value) || res.value.length === 0) {
      return;
    }
    const key = breakdownKeys[index];
    const segmentField = META_BREAKDOWNS[key].field;
    const rows = normalizeBreakdownInsights(res.value, key, segmentField);
    if (rows.length > 0) byDimension[key] = rows;
  });

  const byDay =
    dailyResult[0]?.status === "fulfilled"
      ? normalizeDailyInsights(dailyResult[0].value)
      : [];

  // Build the normalized dataset in the schema the rule engine expects
  const normalizedDataset = buildMetaNormalizedDataset({
    campaignRecords: campaigns,
    adSetRecords: adSets,
    adRecords: ads,
    currency,
    byDimension,
    byDay,
  });

  // Also include 90-day data in a byLevel bucket for historical rules
  normalizedDataset.data.platforms.META.byLevel.campaign_90d = campaigns90d;

  // Persist to DB and update audit status
  await prisma.$transaction(async (tx) => {
    await tx.normalizedDataset.upsert({
      where: { auditId },
      create: {
        auditId,
        data: normalizedDataset.data,
        summary: normalizedDataset.summary,
      },
      update: {
        data: normalizedDataset.data,
        summary: normalizedDataset.summary,
      },
    });

    await tx.audit.update({
      where: { id: auditId },
      data: {
        status: "VALIDATING",
        dataSource: "OAUTH",
      },
    });

    await tx.platformConnection.update({
      where: { id: connection.id },
      data: {
        adAccountId: (
          await tx.adAccount.findFirst({ where: { organizationId, platform: "META" } })
        )?.id || null,
        externalAccountId: externalAdAccountId,
        metadata: {
          externalAdAccountId,
          lastFetchedAt: new Date().toISOString(),
          currency,
        },
      },
    });

    await tx.auditEvent.create({
      data: {
        auditId,
        type: "OAUTH_DATA_FETCHED",
        message: "Meta Ads data fetched via OAuth and normalized successfully.",
        metadata: {
          platform: "META",
          externalAdAccountId,
          currency,
          summary: normalizedDataset.summary,
        },
      },
    });
  });

  res.json({
    status: "success",
    data: {
      auditId,
      platform: "META",
      currency,
      summary: normalizedDataset.summary.platforms?.META || {},
      message: "Meta data fetched and normalized. You can now run the audit.",
    },
  });
};

/**
 * DELETE /api/platform-connections/:connectionId
 * Disconnects and removes a platform connection.
 */
export const disconnectPlatform = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const connection = await prisma.platformConnection.findFirst({
    where: { id: req.params.connectionId, organizationId },
  });

  if (!connection) throw notFound("Connection not found.");

  await prisma.platformConnection.update({
    where: { id: connection.id },
    data: {
      status: "REVOKED",
      accessTokenEncrypted: null,
      refreshTokenEncrypted: null,
    },
  });

  res.json({ status: "success", message: "Platform connection disconnected." });
};

// ── Google OAuth flow ────────────────────────────────────────────────────────

/**
 * Step 1: Redirect the user to Google's authorization dialog.
 * GET /api/platform-connections/google/connect?auditId=...
 */
export const initGoogleOAuth = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { auditId } = req.query;

  const statePayload = JSON.stringify({ organizationId, auditId: auditId || null });
  const state = Buffer.from(statePayload).toString("base64url");

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    state,
    scope: "https://www.googleapis.com/auth/adwords",
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  res.redirect(authUrl);
};

/**
 * Step 2: Google redirects back here with a code.
 * GET /api/platform-connections/google/callback?code=...&state=...
 */
export const googleOAuthCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const FRONTEND_BASE = process.env.CLIENT_ORIGIN || "http://localhost:3000";

  if (error) {
    const message = encodeURIComponent(error_description || error);
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=${message}&platform=GOOGLE`);
  }

  if (!code || !state) {
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=missing_code&platform=GOOGLE`);
  }

  let organizationId, auditId;
  try {
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
    organizationId = decoded.organizationId;
    auditId = decoded.auditId;
  } catch {
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=invalid_state&platform=GOOGLE`);
  }

  try {
    const tokenData = await exchangeGoogleCode(code);
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;

    const encryptedToken = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    const existingConnection = await prisma.platformConnection.findFirst({
      where: { organizationId, platform: "GOOGLE" },
    });

    // If refresh token isn't returned (happens if prompt wasn't consent), use the old one
    const finalRefreshToken = encryptedRefresh || (existingConnection ? existingConnection.refreshTokenEncrypted : null);

    const connectionData = {
      status: "ACTIVE",
      accessTokenEncrypted: encryptedToken,
      refreshTokenEncrypted: finalRefreshToken,
      tokenExpiresAt,
      scopes: ["https://www.googleapis.com/auth/adwords"],
      metadata: {},
    };

    if (existingConnection) {
      await prisma.platformConnection.update({
        where: { id: existingConnection.id },
        data: connectionData,
      });
    } else {
      await prisma.platformConnection.create({
        data: {
          ...connectionData,
          organizationId,
          platform: "GOOGLE",
        },
      });
    }

    if (auditId) {
      res.redirect(`${FRONTEND_BASE}/dashboard/audits/${auditId}/connect?platform=GOOGLE&status=success`);
    } else {
      res.redirect(`${FRONTEND_BASE}/dashboard/settings?platform=GOOGLE&status=success`);
    }
  } catch (err) {
    console.error("[Google OAuth Callback Error]", err);
    res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=server_error&platform=GOOGLE`);
  }
};

// ── Google token refresh helper ───────────────────────────────────────────────

/**
 * Returns a valid (possibly refreshed) access token for the given connection.
 * If the token expires within 5 minutes, refreshes it and updates DB.
 */
const getValidGoogleAccessToken = async (connection) => {
  const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
  const isExpired = !connection.tokenExpiresAt || connection.tokenExpiresAt <= fiveMinutesFromNow;

  if (!isExpired) {
    return decrypt(connection.accessTokenEncrypted);
  }

  if (!connection.refreshTokenEncrypted) {
    throw new Error("Google access token expired and no refresh token is available. Please reconnect your Google account.");
  }

  console.log("[Google Ads] Access token expired — refreshing...");
  const refreshToken = decrypt(connection.refreshTokenEncrypted);
  const refreshed = await refreshGoogleToken(refreshToken);

  const newEncryptedToken = encrypt(refreshed.access_token);
  const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000);

  await prisma.platformConnection.update({
    where: { id: connection.id },
    data: {
      accessTokenEncrypted: newEncryptedToken,
      tokenExpiresAt: newExpiresAt,
    },
  });

  console.log("[Google Ads] ✓ Access token refreshed and saved.");
  return refreshed.access_token;
};

// ── Google data endpoints ─────────────────────────────────────────────────────

/**
 * GET /api/platform-connections/google/ad-accounts
 * Lists all Google Ads customer accounts accessible to the connected user.
 */
export const listGoogleAdAccounts = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const connection = await prisma.platformConnection.findFirst({
    where: { organizationId, platform: "GOOGLE", status: "ACTIVE" },
  });

  if (!connection || !connection.accessTokenEncrypted) {
    throw notFound("No active Google connection found. Please connect your Google Ads account first.");
  }

  const accessToken = await getValidGoogleAccessToken(connection);

  console.log("[Google Ads] Listing accessible customers for org:", organizationId);
  const resourceNames = await fetchAccessibleCustomers(accessToken);

  // Extract customer IDs and fetch details in parallel
  const customerIds = resourceNames.map((r) => r.replace("customers/", ""));

  const customerDetails = await Promise.allSettled(
    customerIds.map((id) => fetchCustomerInfo(accessToken, id))
  );

  const accounts = customerIds.map((id, i) => {
    const result = customerDetails[i];
    const info = result.status === "fulfilled" ? result.value : null;
    return {
      customerId: id,
      name: info?.descriptiveName || `Account ${id}`,
      currencyCode: info?.currencyCode || null,
      timeZone: info?.timeZone || null,
      status: info?.status || null,
      isManager: info?.manager || false,
      resourceName: `customers/${id}`,
    };
  });

  console.log(`[Google Ads] ✓ Returning ${accounts.length} account(s).`);
  res.json({ status: "success", data: accounts });
};

/**
 * POST /api/platform-connections/google/fetch-data
 * Fetches all Google Ads data for an audit and stores it as a NormalizedDataset.
 * Body: { auditId, customerId }
 */
export const fetchGoogleDataForAudit = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { auditId, customerId } = req.body;

  if (!auditId || !customerId) {
    throw badRequest("auditId and customerId are required.");
  }

  console.log(`\n[Google Ads] ═══ Starting data fetch ═══`);
  console.log(`[Google Ads] Org: ${organizationId} | Audit: ${auditId} | Customer: ${customerId}`);

  const [audit, connection] = await Promise.all([
    prisma.audit.findFirst({
      where: { id: auditId, organizationId },
      include: { normalizedDataset: true },
    }),
    prisma.platformConnection.findFirst({
      where: { organizationId, platform: "GOOGLE", status: "ACTIVE" },
    }),
  ]);

  if (!audit) throw notFound("Audit not found.");
  if (!connection || !connection.accessTokenEncrypted) {
    throw notFound("No active Google connection found. Connect your Google account first.");
  }
  if (!audit.selectedPlatforms.includes("GOOGLE")) {
    throw badRequest("This audit does not include GOOGLE as a selected platform.");
  }

  const accessToken = await getValidGoogleAccessToken(connection);

  // Fetch customer info for currency
  const customerInfo = await fetchCustomerInfo(accessToken, customerId);
  const currency = customerInfo?.currencyCode || null;
  console.log(`[Google Ads] Account currency: ${currency}`);

  // Fetch all levels in parallel
  console.log("[Google Ads] Fetching all report data in parallel...");

  let rawCampaigns30d, rawAdGroups30d, rawAds30d, rawCampaigns90d,
      rawKeywords, rawSearchTerms, rawNegativeLists, rawPMaxAssets,
      rawShoppingProducts, rawAudienceBidding;

  if (customerInfo?.manager) {
    console.log(`[Google Ads] Manager account detected — fetching sub-accounts...`);
    const subAccounts = await fetchManagerSubAccounts(accessToken, customerId);
    if (subAccounts.length === 0) {
      throw badRequest("No active client accounts found under this manager account.");
    }
    const subResults = await Promise.all(
      subAccounts.map((sub) =>
        Promise.all([
          fetchCampaignsWithMetrics(accessToken, sub.id, "LAST_30_DAYS", customerId),
          fetchAdGroupsWithMetrics(accessToken, sub.id, "LAST_30_DAYS", customerId),
          fetchAdsWithMetrics(accessToken, sub.id, "LAST_30_DAYS", customerId),
          fetchCampaignsWithMetrics(accessToken, sub.id, "LAST_90_DAYS", customerId),
          fetchKeywordsWithMetrics(accessToken, sub.id, "LAST_30_DAYS", customerId),
          fetchSearchTerms(accessToken, sub.id, customerId),
          fetchNegativeKeywordLists(accessToken, sub.id, customerId),
          fetchPMaxAssets(accessToken, sub.id, customerId),
          fetchShoppingProducts(accessToken, sub.id, customerId),
          fetchAudienceBidding(accessToken, sub.id, customerId),
        ])
      )
    );
    rawCampaigns30d      = subResults.flatMap((r) => r[0]);
    rawAdGroups30d       = subResults.flatMap((r) => r[1]);
    rawAds30d            = subResults.flatMap((r) => r[2]);
    rawCampaigns90d      = subResults.flatMap((r) => r[3]);
    rawKeywords          = subResults.flatMap((r) => r[4]);
    rawSearchTerms       = subResults.flatMap((r) => r[5]);
    rawNegativeLists     = subResults.flatMap((r) => r[6]);
    rawPMaxAssets        = subResults.flatMap((r) => r[7]);
    rawShoppingProducts  = subResults.flatMap((r) => r[8]);
    rawAudienceBidding   = subResults.flatMap((r) => r[9]);
  } else {
    [
      rawCampaigns30d, rawAdGroups30d, rawAds30d, rawCampaigns90d,
      rawKeywords, rawSearchTerms, rawNegativeLists, rawPMaxAssets,
      rawShoppingProducts, rawAudienceBidding,
    ] = await Promise.all([
      fetchCampaignsWithMetrics(accessToken, customerId, "LAST_30_DAYS"),
      fetchAdGroupsWithMetrics(accessToken, customerId, "LAST_30_DAYS"),
      fetchAdsWithMetrics(accessToken, customerId, "LAST_30_DAYS"),
      fetchCampaignsWithMetrics(accessToken, customerId, "LAST_90_DAYS"),
      fetchKeywordsWithMetrics(accessToken, customerId, "LAST_30_DAYS"),
      fetchSearchTerms(accessToken, customerId),
      fetchNegativeKeywordLists(accessToken, customerId),
      fetchPMaxAssets(accessToken, customerId),
      fetchShoppingProducts(accessToken, customerId),
      fetchAudienceBidding(accessToken, customerId),
    ]);
  }

  // Normalize
  console.log("[Google Ads] Normalizing fetched data...");
  const campaigns          = normalizeCampaigns(rawCampaigns30d);
  const adGroups           = normalizeAdGroups(rawAdGroups30d);
  const ads                = normalizeAds(rawAds30d);
  const campaigns90d       = normalizeCampaigns(rawCampaigns90d);
  const keywords           = normalizeKeywords(rawKeywords);
  const searchTerms        = normalizeSearchTerms(rawSearchTerms);
  const negativeLists      = normalizeNegativeKeywordLists(rawNegativeLists);
  const pmaxAssets         = normalizePMaxAssets(rawPMaxAssets);
  const shoppingProducts   = normalizeShoppingProducts(rawShoppingProducts);
  const audienceBidding    = normalizeAudienceBidding(rawAudienceBidding);

  console.log(
    `[Google Ads] Normalized: ${campaigns.length} campaigns, ${adGroups.length} ad groups, ` +
    `${ads.length} ads, ${keywords.length} keywords, ${searchTerms.length} search terms, ` +
    `${negativeLists.length} negative lists, ${pmaxAssets.length} PMax assets, ` +
    `${shoppingProducts.length} shopping products, ${audienceBidding.length} audience criteria`
  );

  // Daily time series — BEST-EFFORT. Never fail the audit on a daily-fetch error.
  let googleByDay = [];
  try {
    const dailyRows = await fetchDailySegments(accessToken, customerId, "LAST_30_DAYS");
    googleByDay = normalizeGoogleDailySegments(dailyRows);
  } catch (dailyErr) {
    console.warn(`[Google Ads] daily segment fetch failed (non-fatal): ${dailyErr.message}`);
  }

  // Segment breakdowns (device / day-of-week / network) — BEST-EFFORT. These
  // power per-segment waste analysis (analyzeSegments + SEG-WASTE-001). Skipped
  // for manager accounts (segments live on sub-accounts, not the manager).
  let googleByDimension = {};
  try {
    if (!customerInfo?.manager) {
      const breakdowns = await fetchSegmentBreakdowns(accessToken, customerId, "LAST_30_DAYS");
      googleByDimension = buildGoogleByDimension(breakdowns);
    }
  } catch (segErr) {
    console.warn(`[Google Ads] segment breakdown fetch failed (non-fatal): ${segErr.message}`);
  }

  const googleDataset = buildGoogleNormalizedDataset({
    campaignRecords: campaigns,
    adGroupRecords: adGroups,
    adRecords: ads,
    keywordRecords: keywords,
    searchTermRecords: searchTerms,
    negativeListRecords: negativeLists,
    pmaxAssetRecords: pmaxAssets,
    shoppingProductRecords: shoppingProducts,
    audienceBiddingRecords: audienceBidding,
    currency,
    byDay: googleByDay,
    byDimension: googleByDimension,
  });

  // Include 90-day campaign data for historical rules
  googleDataset.data.platforms.GOOGLE.byLevel.campaign_90d = campaigns90d;

  // Merge with existing normalized dataset (preserves other platforms like META)
  await prisma.$transaction(async (tx) => {
    const existing = await tx.normalizedDataset.findUnique({ where: { auditId } });

    let mergedData, mergedSummary;
    if (existing) {
      const existingData = existing.data;
      const existingSummary = existing.summary;
      mergedData = {
        ...existingData,
        platforms: {
          ...(existingData?.platforms || {}),
          GOOGLE: googleDataset.data.platforms.GOOGLE,
        },
      };
      mergedSummary = {
        ...existingSummary,
        platforms: {
          ...(existingSummary?.platforms || {}),
          GOOGLE: googleDataset.summary.platforms.GOOGLE,
        },
        totals: googleDataset.summary.totals,
      };
    } else {
      mergedData = googleDataset.data;
      mergedSummary = googleDataset.summary;
    }

    await tx.normalizedDataset.upsert({
      where: { auditId },
      create: { auditId, data: mergedData, summary: mergedSummary },
      update: { data: mergedData, summary: mergedSummary },
    });

    await tx.audit.update({
      where: { id: auditId },
      data: { status: "VALIDATING", dataSource: "OAUTH" },
    });

    await tx.platformConnection.update({
      where: { id: connection.id },
      data: {
        externalAccountId: customerId,
        metadata: {
          customerId,
          lastFetchedAt: new Date().toISOString(),
          currency,
        },
      },
    });

    await tx.auditEvent.create({
      data: {
        auditId,
        type: "OAUTH_DATA_FETCHED",
        message: "Google Ads data fetched via OAuth and normalized successfully.",
        metadata: {
          platform: "GOOGLE",
          customerId,
          summary: googleDataset.summary.platforms.GOOGLE,
        },
      },
    });
  });

  const summaryOut = googleDataset.summary.platforms.GOOGLE;
  console.log("[Google Ads] ✓ Data stored. Summary:", summaryOut);
  console.log(`[Google Ads] ═══ Data fetch complete ═══\n`);

  res.json({
    status: "success",
    data: {
      auditId,
      platform: "GOOGLE",
      customerId,
      currency,
      summary: summaryOut,
      message: "Google Ads data fetched and normalized. You can now run the audit.",
    },
  });
};
