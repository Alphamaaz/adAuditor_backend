import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  getBranding,
  updateBranding,
  uploadLogo,
  deleteLogo,
  uploadLogoMiddleware,
  listAccounts,
  listMembers,
  assignAccount,
  updateAccountMonitoring,
  updateAlertPreferences,
} from "./organizations.controller.js";

const router = Router();

router.use(requireAuth);

router.get("/branding", asyncHandler(getBranding));
router.put("/branding", asyncHandler(updateBranding));
router.post("/branding/logo", uploadLogoMiddleware, asyncHandler(uploadLogo));
router.delete("/branding/logo", asyncHandler(deleteLogo));

// Agency alert routing: assign accounts to members + per-user mute.
router.get("/accounts", asyncHandler(listAccounts));
router.get("/members", asyncHandler(listMembers));
router.patch("/accounts/:adAccountId/assignee", asyncHandler(assignAccount));
router.patch("/accounts/:adAccountId/monitoring", asyncHandler(updateAccountMonitoring));
router.patch("/alert-preferences", asyncHandler(updateAlertPreferences));

export default router;
