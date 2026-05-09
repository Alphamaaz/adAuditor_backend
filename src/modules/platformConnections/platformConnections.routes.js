import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import {
  initMetaOAuth,
  metaOAuthCallback,
  listConnections,
  listMetaAdAccounts,
  fetchMetaDataForAudit,
  disconnectPlatform,
} from "./platformConnections.controller.js";

const router = Router();

// ── Meta OAuth flow (these two are special) ──────────────────────────────────
// Initiation requires a logged-in user; callback is redirected by Meta so we
// decode org from the `state` param instead of a session cookie.
router.get("/meta/connect", requireAuth, asyncHandler(initMetaOAuth));
router.get("/meta/callback", asyncHandler(metaOAuthCallback)); // No requireAuth — comes from Meta

// ── Connection management ────────────────────────────────────────────────────
router.use(requireAuth); // All routes below require auth

router.get("/", asyncHandler(listConnections));
router.get("/meta/ad-accounts", asyncHandler(listMetaAdAccounts));
router.post("/meta/fetch-data", asyncHandler(fetchMetaDataForAudit));
router.delete("/:connectionId", asyncHandler(disconnectPlatform));

export default router;
