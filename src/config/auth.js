export const SESSION_COOKIE_NAME = "ad_auditor_session";
export const ADMIN_IMPERSONATION_COOKIE_NAME = "ad_auditor_admin_session";
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);

export const getSessionCookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "lax" : "lax",
  maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
  path: "/",
  ...(process.env.NODE_ENV === "production" ? { domain: ".adadviser.uk" } : {}),
});
