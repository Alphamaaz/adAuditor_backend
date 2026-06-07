/**
 * Sentry init. Safe no-op when SENTRY_DSN is unset (e.g. local dev).
 * Call initSentry() BEFORE constructing the Express app or the worker.
 */
import * as Sentry from "@sentry/node";

let initialized = false;

export const initSentry = () => {
  if (initialized) return Sentry;
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return Sentry; // no-op
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
    profilesSampleRate: Number(process.env.SENTRY_PROFILES_SAMPLE_RATE || 0.0),
  });
  initialized = true;
  return Sentry;
};

export { Sentry };
