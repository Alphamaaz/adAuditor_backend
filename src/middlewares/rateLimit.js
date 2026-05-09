import { tooManyRequests } from "../utils/appError.js";

/**
 * Lightweight in-memory rate limiter — fixed-window by IP+key.
 *
 * Why in-memory and not Redis: the project already depends on ioredis, but
 * forcing devs to run Redis just to sign up is friction. This limiter is fine
 * for a single-process VPS deploy. When we move to multi-instance, swap the
 * `store` for an ioredis-backed one with the same interface.
 *
 * Usage:
 *   app.use("/api/auth/login", rateLimit({ windowMs: 60_000, max: 10 }))
 */

const buildStore = () => {
  const buckets = new Map();

  // Periodic sweep so the map doesn't grow unbounded.
  const sweep = () => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  // Run sweep every minute. Unref so it doesn't keep the process alive.
  const interval = setInterval(sweep, 60_000);
  if (typeof interval.unref === "function") interval.unref();

  return {
    increment(key, windowMs) {
      const now = Date.now();
      const existing = buckets.get(key);

      if (!existing || existing.resetAt <= now) {
        const bucket = { count: 1, resetAt: now + windowMs };
        buckets.set(key, bucket);
        return bucket;
      }

      existing.count += 1;
      return existing;
    },
    reset(key) {
      buckets.delete(key);
    },
  };
};

const defaultStore = buildStore();

const getClientKey = (req) => {
  // Prefer forwarded IP (behind reverse proxy), then req.ip, then a constant
  // fallback so we still apply some throttling rather than none.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.connection?.remoteAddress || "unknown";
};

/**
 * Build a rate-limit middleware.
 *
 * @param {object} options
 * @param {number} options.windowMs        Time window in ms.
 * @param {number} options.max             Max requests per key per window.
 * @param {string} [options.scope]         Scope label appended to the key (so
 *                                         /login and /signup share IPs but
 *                                         have separate counters).
 * @param {(req: any) => string} [options.keyFn]  Custom key extractor.
 * @param {string} [options.message]       Error message on 429.
 */
export const rateLimit = ({
  windowMs = 60_000,
  max = 60,
  scope = "global",
  keyFn,
  message = "Too many requests. Please slow down and try again shortly.",
} = {}) => {
  return (req, res, next) => {
    try {
      const baseKey = typeof keyFn === "function" ? keyFn(req) : getClientKey(req);
      const key = `${scope}:${baseKey}`;
      const bucket = defaultStore.increment(key, windowMs);

      const remaining = Math.max(0, max - bucket.count);
      const resetSeconds = Math.ceil((bucket.resetAt - Date.now()) / 1000);

      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String(resetSeconds));

      if (bucket.count > max) {
        res.setHeader("Retry-After", String(Math.max(1, resetSeconds)));
        return next(
          tooManyRequests(message, {
            retryAfterSeconds: Math.max(1, resetSeconds),
            windowMs,
            max,
          })
        );
      }

      next();
    } catch (error) {
      // Never block requests because the limiter itself blew up.
      next();
    }
  };
};

/**
 * Stricter limiter for auth-sensitive endpoints. 10 attempts / 15 min by IP.
 * Tweak via env if needed.
 */
export const authRateLimit = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 10),
  scope: "auth",
  message:
    "Too many authentication attempts. Wait a few minutes before trying again.",
});

/**
 * For OTP requests (resend OTP, forgot password) — even tighter.
 * 5 per 15 min by IP; users typically need ≤ 2.
 */
export const otpRateLimit = rateLimit({
  windowMs: Number(process.env.OTP_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
  max: Number(process.env.OTP_RATE_LIMIT_MAX || 5),
  scope: "otp",
  message:
    "Too many code requests. Please wait a few minutes before requesting another code.",
});

/**
 * For file upload endpoints. Defaults to 30/min per IP.
 */
export const uploadRateLimit = rateLimit({
  windowMs: Number(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.UPLOAD_RATE_LIMIT_MAX || 30),
  scope: "upload",
  message:
    "You're uploading too quickly. Please wait a moment before retrying.",
});

/**
 * For audit run / AI report endpoints — very expensive, throttle to 10/min.
 */
export const expensiveRateLimit = rateLimit({
  windowMs: Number(process.env.EXPENSIVE_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.EXPENSIVE_RATE_LIMIT_MAX || 10),
  scope: "expensive",
  message:
    "You're running audits faster than we can process them. Slow down and retry.",
});
