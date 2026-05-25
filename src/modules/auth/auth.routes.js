import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireAuth } from "../../middlewares/auth.js";
import { validateBody } from "../../middlewares/validate.js";
import { authRateLimit, otpRateLimit } from "../../middlewares/rateLimit.js";
import {
  signupSchema,
  loginSchema,
  verifyEmailSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
  googleAuthSchema,
} from "./auth.schemas.js";
import {
  signup,
  verifyEmail,
  resendOtp,
  login,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
  changePassword,
  updateProfile,
  listSessions,
  revokeOtherSessions,
  googleAuth,
  metaInit,
  metaCallback,
  tiktokInit,
  tiktokCallback,
} from "./auth.controller.js";

const router = Router();

// Public routes — rate-limited to slow brute-force / enumeration attempts.
router.post(
  "/signup",
  authRateLimit,
  validateBody(signupSchema),
  asyncHandler(signup)
);
router.post(
  "/verify-email",
  authRateLimit,
  validateBody(verifyEmailSchema),
  asyncHandler(verifyEmail)
);
router.post(
  "/resend-otp",
  otpRateLimit,
  validateBody(resendOtpSchema),
  asyncHandler(resendOtp)
);
router.post(
  "/login",
  authRateLimit,
  validateBody(loginSchema),
  asyncHandler(login)
);
router.post("/logout", asyncHandler(logout));
router.post(
  "/google",
  authRateLimit,
  validateBody(googleAuthSchema),
  asyncHandler(googleAuth)
);
router.post(
  "/forgot-password",
  otpRateLimit,
  validateBody(forgotPasswordSchema),
  asyncHandler(forgotPassword)
);
router.post(
  "/reset-password",
  authRateLimit,
  validateBody(resetPasswordSchema),
  asyncHandler(resetPassword)
);

// Meta OAuth
router.get("/meta/init", asyncHandler(metaInit));
router.get("/meta/callback", asyncHandler(metaCallback));

// TikTok OAuth
router.get("/tiktok/init", asyncHandler(tiktokInit));
router.get("/tiktok/callback", asyncHandler(tiktokCallback));

// Protected routes
router.get("/me", requireAuth, asyncHandler(getCurrentUser));
router.patch("/profile", requireAuth, validateBody(updateProfileSchema), asyncHandler(updateProfile));
router.post("/change-password", requireAuth, validateBody(changePasswordSchema), asyncHandler(changePassword));
router.get("/sessions", requireAuth, asyncHandler(listSessions));
router.post("/sessions/revoke-others", requireAuth, asyncHandler(revokeOtherSessions));

export default router;
