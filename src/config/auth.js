export const SESSION_COOKIE_NAME = "ad_auditor_session";
export const ADMIN_IMPERSONATION_COOKIE_NAME = "ad_auditor_admin_session";
export const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 30);

/**
 * Session cookie options. `domain` is opt-in via SESSION_COOKIE_DOMAIN —
 * set it only when you need the cookie to span subdomains
 * (e.g. ".acme.com" so app.acme.com and api.acme.com share the session).
 * When unset, the browser scopes the cookie to the API's exact host, which
 * is the correct default for single-domain deployments.
 */
export const getSessionCookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";
  const explicitDomain = process.env.SESSION_COOKIE_DOMAIN?.trim();
  const sameSite = (process.env.SESSION_COOKIE_SAMESITE || "lax").toLowerCase();

  return {
    httpOnly: true,
    secure: isProd,
    sameSite,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
    path: "/",
    ...(explicitDomain ? { domain: explicitDomain } : {}),
  };
};
