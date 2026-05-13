import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import {
  initMetaOAuth,
  metaOAuthCallback,
  initTikTokOAuth,
  tikTokOAuthCallback,
  listConnections,
  listMetaAdAccounts,
  fetchMetaDataForAudit,
  disconnectPlatform,
} from "./platformConnections.controller.js";

const router = Router();

// ── Platform OAuth flows (these are special) ─────────────────────────────────
// Initiation requires a logged-in user; callback is redirected by platform
// so we decode org from the `state` param instead of a session cookie.
router.get("/meta/connect", requireAuth, asyncHandler(initMetaOAuth));
router.get("/meta/callback", asyncHandler(metaOAuthCallback));

router.get("/tiktok/connect", requireAuth, asyncHandler(initTikTokOAuth));
router.get("/tiktok/callback", asyncHandler(tikTokOAuthCallback));

// ── Connection management ────────────────────────────────────────────────────
router.use(requireAuth); // All routes below require auth

router.get("/", asyncHandler(listConnections));
router.get("/meta/ad-accounts", asyncHandler(listMetaAdAccounts));
router.post("/meta/fetch-data", asyncHandler(fetchMetaDataForAudit));
router.delete("/:connectionId", asyncHandler(disconnectPlatform));

export default router;
