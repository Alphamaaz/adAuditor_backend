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
} from "./meta.service.js";
import {
  normalizeCampaignInsights,
  normalizeAdSetInsights,
  normalizeAdInsights,
  enrichCampaignsWithStructure,
  enrichAdSetsWithStructure,
  enrichAdsWithStructure,
  buildMetaNormalizedDataset,
} from "./metaNormalizer.service.js";
import {
  exchangeCodeForToken as exchangeTikTokCode,
  fetchAdAccounts as fetchTikTokAdAccounts,
} from "./tiktok.service.js";
import { exchangeCodeForToken as exchangeGoogleCode } from "./google.service.js";

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
    client_key: process.env.TIKTOK_CLIENT_KEY,
    redirect_uri: process.env.TIKTOK_CALLBACK_URL,
    state,
    scope: "user.info.profile",
    response_type: "code",
  });

  const authUrl = `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  res.redirect(authUrl);
};

/**
 * Step 2: TikTok redirects back with a code.
 */
export const tikTokOAuthCallback = async (req, res) => {
  const { code, state, error, error_description } = req.query;
  const FRONTEND_BASE = process.env.CLIENT_ORIGIN || "http://localhost:3000";

  if (error || !code || !state) {
    const msg = encodeURIComponent(error_description || "Missing OAuth code");
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
    const tokenData = await exchangeTikTokCode(code);
    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in;

    const encryptedToken = encrypt(accessToken);
    const encryptedRefresh = refreshToken ? encrypt(refreshToken) : null;
    const tokenExpiresAt = new Date(Date.now() + expiresIn * 1000);

    const existingConnection = await prisma.platformConnection.findFirst({
      where: { organizationId, platform: "TIKTOK" },
    });

    const scopeString = tokenData.scope || "";
    const scopes = scopeString.includes(",") 
      ? scopeString.split(",").map(s => s.trim())
      : scopeString.split(" ").map(s => s.trim()).filter(Boolean);

    const connectionData = {
      status: "ACTIVE",
      accessTokenEncrypted: encryptedToken,
      refreshTokenEncrypted: encryptedRefresh,
      tokenExpiresAt,
      scopes: scopes.length > 0 ? scopes : ["user.info.profile"],
      metadata: { open_id: tokenData.open_id },
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
          platform: "TIKTOK",
        },
      });
    }

    const successUrl = auditId
      ? `${FRONTEND_BASE}/dashboard/audits/${auditId}/connect?platform=TIKTOK&connected=true`
      : `${FRONTEND_BASE}/dashboard?platform=TIKTOK&connected=true`;

    return res.redirect(successUrl);
  } catch (err) {
    console.error("[TikTok OAuth Callback Error]", err.message);
    return res.redirect(`${FRONTEND_BASE}/dashboard?oauth_error=failed_tiktok_connection&platform=TIKTOK`);
  }
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

  // Build the normalized dataset in the schema the rule engine expects
  const normalizedDataset = buildMetaNormalizedDataset({
    campaignRecords: campaigns,
    adSetRecords: adSets,
    adRecords: ads,
    currency: null, // fetched per-account below if needed
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
