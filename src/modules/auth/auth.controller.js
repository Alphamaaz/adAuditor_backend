import axios from "axios";
import { prisma } from "../../lib/prisma.js";
import {
  SESSION_COOKIE_NAME,
  ADMIN_IMPERSONATION_COOKIE_NAME,
  SESSION_TTL_DAYS,
  getSessionCookieOptions,
} from "../../config/auth.js";
import { unauthorized, badRequest, forbidden } from "../../utils/appError.js";
import { hashPassword, verifyPassword } from "../../utils/password.js";
import {
  createSessionToken,
  hashSessionToken,
} from "../../utils/sessionToken.js";
import {
  generateOtp,
  hashOtp,
  OTP_TTL_MINUTES,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
} from "../../utils/otp.js";
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from "../../utils/email.js";
import {
  serializeAuthPayload,
  serializeAuthSession,
} from "./auth.presenter.js";


// Session helpers

const getSessionExpiresAt = () =>
  new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

const getRequestIp = (req) => req.ip || req.socket?.remoteAddress;

const setSessionCookie = (res, token) =>
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions());

const clearSessionCookie = (res) =>
  res.clearCookie(SESSION_COOKIE_NAME, {
    ...getSessionCookieOptions(),
    maxAge: undefined,
  });

const createSession = async (tx, req, userId) => {
  const token = createSessionToken();
  await tx.authSession.create({
    data: {
      userId,
      tokenHash: hashSessionToken(token),
      userAgent: req.get("user-agent"),
      ipAddress: getRequestIp(req),
      expiresAt: getSessionExpiresAt(),
    },
  });
  return token;
};

const fetchUserWithMemberships = (tx, userId) =>
  tx.user.findUniqueOrThrow({
    where: { id: userId },
    include: {
      memberships: {
        include: {
          organization: {
            include: {
              businessProfile: true,
              subscription: { include: { plan: true } },
              planOverride: { include: { plan: true } },
            },
          },
        },
      },
    },
  });

// OTP helpers

const issueVerificationToken = async (tx, userId, purpose) => {
  await tx.verificationToken.deleteMany({ where: { userId, purpose } });

  const otp = generateOtp();
  await tx.verificationToken.create({
    data: {
      userId,
      tokenHash: hashOtp(otp),
      purpose,
      expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
    },
  });

  return otp;
};

// Checks cooldown using a direct DB read (outside any transaction).
const checkResendCooldown = async (userId, purpose) => {
  const recent = await prisma.verificationToken.findFirst({
    where: { userId, purpose },
    orderBy: { createdAt: "desc" },
  });

  if (recent) {
    const elapsedSeconds = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (elapsedSeconds < OTP_RESEND_COOLDOWN_SECONDS) {
      const wait = Math.ceil(OTP_RESEND_COOLDOWN_SECONDS - elapsedSeconds);
      throw badRequest(`Please wait ${wait} second${wait === 1 ? "" : "s"} before requesting a new code.`);
    }
  }
};

// Validates the OTP, increments attempt counter, and marks token as used on success.
const consumeOtp = async (tx, userId, purpose, otp) => {
  const token = await tx.verificationToken.findFirst({
    where: { userId, purpose, usedAt: null },
    orderBy: { createdAt: "desc" },
  });

  if (!token || token.expiresAt < new Date()) {
    throw badRequest("Invalid or expired code. Please request a new one.");
  }

  if (token.attempts >= OTP_MAX_ATTEMPTS) {
    throw badRequest("Too many incorrect attempts. Please request a new code.");
  }

  // Increment before comparing to prevent brute-force exhaustion bypass.
  await tx.verificationToken.update({
    where: { id: token.id },
    data: { attempts: { increment: 1 } },
  });

  if (token.tokenHash !== hashOtp(otp)) {
    const remaining = OTP_MAX_ATTEMPTS - (token.attempts + 1);
    if (remaining <= 0) {
      throw badRequest("Too many incorrect attempts. Please request a new code.");
    }
    throw badRequest(
      `Incorrect code. ${remaining} attempt${remaining === 1 ? "" : "s"} remaining.`
    );
  }

  await tx.verificationToken.update({
    where: { id: token.id },
    data: { usedAt: new Date() },
  });
};

// Controllers

export const signup = async (req, res) => {
  const { email, password, name, organizationName } = req.body;
  const passwordHash = await hashPassword(password);

  const { userId } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email, name, passwordHash, status: "PENDING" },
    });

    const organization = await tx.organization.create({
      data: {
        name: organizationName || `${name || email}'s Organization`,
        ownerId: user.id,
      },
    });

    await tx.organizationMember.create({
      data: { userId: user.id, organizationId: organization.id, role: "OWNER" },
    });

    await tx.subscription.create({
      data: { organizationId: organization.id, status: "TRIALING" },
    });

    const otp = await issueVerificationToken(tx, user.id, "EMAIL_VERIFICATION");

    // Send outside the transaction so a failed send doesn't roll back user creation.
    // We store userId+otp to send after commit.
    return { userId: user.id, otp };
  }).then(async ({ userId, otp }) => {
    await sendVerificationEmail(email, otp);
    return { userId };
  });

  res.status(201).json({
    status: "success",
    message: "Account created. Please check your email for a 6-digit verification code.",
  });
};

export const verifyEmail = async (req, res) => {
  const { email, otp } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.status !== "PENDING") {
    throw badRequest("No pending verification found for this email.");
  }

  const result = await prisma.$transaction(async (tx) => {
    await consumeOtp(tx, user.id, "EMAIL_VERIFICATION", otp);

    await tx.user.update({
      where: { id: user.id },
      data: { status: "ACTIVE", emailVerifiedAt: new Date() },
    });

    const token = await createSession(tx, req, user.id);
    const fullUser = await fetchUserWithMemberships(tx, user.id);
    return { token, user: fullUser };
  });

  setSessionCookie(res, result.token);

  res.json({
    status: "success",
    data: serializeAuthPayload(result.user),
  });
};

export const resendOtp = async (req, res) => {
  const { email } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  // Always return a generic message to prevent email enumeration.
  if (!user || user.status !== "PENDING") {
    res.json({
      status: "success",
      message: "If a pending account exists for this email, a new code has been sent.",
    });
    return;
  }

  await checkResendCooldown(user.id, "EMAIL_VERIFICATION");

  const otp = await prisma.$transaction((tx) =>
    issueVerificationToken(tx, user.id, "EMAIL_VERIFICATION")
  );

  await sendVerificationEmail(email, otp);

  res.json({
    status: "success",
    message: "A new verification code has been sent to your email.",
  });
};

export const login = async (req, res) => {
  const { email, password } = req.body;

  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      memberships: {
        include: {
          organization: { include: { businessProfile: true } },
        },
      },
    },
  });

  // Google-only accounts have no password — give a helpful message.
  if (user && !user.passwordHash) {
    throw unauthorized("This account uses Google Sign-In. Please continue with Google.");
  }

  const isValidPassword =
    user && (await verifyPassword(password, user.passwordHash));

  // Constant-time response: do not reveal whether the email exists.
  if (!user || !isValidPassword) {
    throw unauthorized("Invalid email or password.");
  }

  if (user.status === "PENDING") {
    throw unauthorized(
      "Please verify your email address before logging in. Check your inbox or request a new code."
    );
  }

  if (user.status === "SUSPENDED") {
    throw forbidden("Your account has been suspended. Please contact support.");
  }

  if (user.status !== "ACTIVE") {
    throw unauthorized("Your account is not active.");
  }

  const token = await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return createSession(tx, req, user.id);
  });

  setSessionCookie(res, token);

  res.json({
    status: "success",
    data: serializeAuthPayload(user),
  });
};

export const logout = async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (token) {
    await prisma.authSession.updateMany({
      where: { tokenHash: hashSessionToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  clearSessionCookie(res);

  res.json({ status: "success", message: "Logged out." });
};

export const getCurrentUser = async (req, res) => {
  const isImpersonating = !!req.cookies[ADMIN_IMPERSONATION_COOKIE_NAME];
  res.json({
    status: "success",
    data: serializeAuthPayload(req.user, isImpersonating),
  });
};

export const forgotPassword = async (req, res) => {
  const { email } = req.body;

  const GENERIC_MESSAGE =
    "If an account with that email exists, a reset code has been sent.";

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.status !== "ACTIVE") {
    res.json({ status: "success", message: GENERIC_MESSAGE });
    return;
  }

  await checkResendCooldown(user.id, "PASSWORD_RESET");

  const otp = await prisma.$transaction((tx) =>
    issueVerificationToken(tx, user.id, "PASSWORD_RESET")
  );

  await sendPasswordResetEmail(email, otp);

  res.json({ status: "success", message: GENERIC_MESSAGE });
};

export const resetPassword = async (req, res) => {
  const { email, otp, newPassword } = req.body;

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.status !== "ACTIVE") {
    throw badRequest("Invalid or expired reset code.");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await consumeOtp(tx, user.id, "PASSWORD_RESET", otp);

    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Invalidate all sessions and force re-login with the new password.
    await tx.authSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  });

  clearSessionCookie(res);

  res.json({
    status: "success",
    message: "Password reset successful. Please log in with your new password.",
  });
};

export const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = req.user;

  if (!user.passwordHash) {
    throw badRequest("Your account uses Google Sign-In and does not have a password.");
  }

  const isValid = await verifyPassword(currentPassword, user.passwordHash);
  if (!isValid) {
    throw badRequest("Current password is incorrect.");
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash } });

    // Revoke all other sessions; keep the current one active.
    await tx.authSession.updateMany({
      where: {
        userId: user.id,
        revokedAt: null,
        id: { not: req.authSession.id },
      },
      data: { revokedAt: new Date() },
    });
  });

  res.json({ status: "success", message: "Password changed successfully." });
};

export const updateProfile = async (req, res) => {
  const { name, organizationName } = req.body;
  const membership = req.user.memberships?.[0];

  const updatedUser = await prisma.$transaction(async (tx) => {
    if (name) {
      await tx.user.update({
        where: { id: req.user.id },
        data: { name },
      });
    }

    if (organizationName) {
      if (!membership || membership.role !== "OWNER") {
        throw forbidden("Only organization owners can update organization details.");
      }

      await tx.organization.update({
        where: { id: membership.organizationId },
        data: { name: organizationName },
      });
    }

    return fetchUserWithMemberships(tx, req.user.id);
  });

  res.json({
    status: "success",
    data: serializeAuthPayload(updatedUser),
  });
};

export const listSessions = async (req, res) => {
  const sessions = await prisma.authSession.findMany({
    where: {
      userId: req.user.id,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json({
    status: "success",
    data: sessions.map((session) =>
      serializeAuthSession(session, req.authSession.id)
    ),
  });
};

export const revokeOtherSessions = async (req, res) => {
  const result = await prisma.authSession.updateMany({
    where: {
      userId: req.user.id,
      revokedAt: null,
      id: { not: req.authSession.id },
    },
    data: {
      revokedAt: new Date(),
    },
  });

  res.json({
    status: "success",
    message: "Other sessions revoked.",
    data: {
      revokedCount: result.count,
    },
  });
};

export const googleAuth = async (req, res) => {
  const { accessToken } = req.body;

  // Verify the access token by calling Google's userinfo endpoint.
  let googleUser;
  try {
    const { data } = await axios.get(
      "https://www.googleapis.com/oauth2/v3/userinfo",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    googleUser = data;
  } catch {
    throw unauthorized("Invalid Google token. Please try again.");
  }

  const { sub: googleId, email, name, email_verified: emailVerified } = googleUser;

  if (!emailVerified) {
    throw badRequest("Your Google account email is not verified.");
  }

  const result = await prisma.$transaction(async (tx) => {
    // Find by googleId first, fall back to email to link existing accounts.
    let user = await tx.user.findFirst({
      where: { OR: [{ googleId }, { email }] },
    });

    if (user?.status === "SUSPENDED") {
      throw forbidden("Your account has been suspended. Please contact support.");
    }

    if (!user) {
      // Brand new user — create account, org, and trial subscription.
      user = await tx.user.create({
        data: {
          email,
          name: name || email.split("@")[0],
          googleId,
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
        },
      });

      const organization = await tx.organization.create({
        data: {
          name: `${name || email}'s Organization`,
          ownerId: user.id,
        },
      });

      await tx.organizationMember.create({
        data: { userId: user.id, organizationId: organization.id, role: "OWNER" },
      });

      await tx.subscription.create({
        data: { organizationId: organization.id, status: "TRIALING" },
      });
    } else if (!user.googleId) {
      // Existing email/password user — link their Google account.
      user = await tx.user.update({
        where: { id: user.id },
        data: {
          googleId,
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          // If they were PENDING (unverified), Google has now verified their email.
          status: user.status === "PENDING" ? "ACTIVE" : user.status,
        },
      });
    }

    await tx.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = await createSession(tx, req, user.id);
    const fullUser = await fetchUserWithMemberships(tx, user.id);
    return { token, user: fullUser };
  });

  setSessionCookie(res, result.token);

  res.json({
    status: "success",
    data: serializeAuthPayload(result.user),
  });
};
