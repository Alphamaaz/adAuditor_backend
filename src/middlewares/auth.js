import { prisma } from "../lib/prisma.js";
import { SESSION_COOKIE_NAME } from "../config/auth.js";
import { unauthorized, forbidden } from "../utils/appError.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { hashSessionToken } from "../utils/sessionToken.js";

export const requireAuth = asyncHandler(async (req, res, next) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];

  if (!token) {
    throw unauthorized("Authentication required");
  }

  const session = await prisma.authSession.findUnique({
    where: {
      tokenHash: hashSessionToken(token),
    },
    include: {
      user: {
        include: {
          memberships: {
            include: {
              organization: { include: { businessProfile: true } },
            },
          },
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt <= new Date()) {
    throw unauthorized("Session is invalid or expired");
  }

  if (session.user.status !== "ACTIVE") {
    throw forbidden("User account is not active");
  }

  req.authSession = session;
  req.user = session.user;
  next();
});

export const requireInternalRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.internalRole)) {
    next(forbidden("Insufficient permissions"));
    return;
  }

  next();
};
