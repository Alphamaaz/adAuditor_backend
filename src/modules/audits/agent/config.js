/**
 * Deep Audit — feature flag + budget configuration. (spec: docs/DEEP_AUDIT_SPEC.md)
 *
 * The whole agentic subsystem is gated behind DEEP_AUDIT_ENABLED (default off),
 * independent of plan. Token budget + max tool calls bound the loop cost; the
 * orchestrator enforces them and degrades to the standard single-shot report.
 */

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Master kill switch — the route 404s and nothing runs unless this is "true". */
export const isDeepAuditEnabled = () =>
  String(process.env.DEEP_AUDIT_ENABLED || "").toLowerCase() === "true";

/** Opus is required for the reasoning quality the loop depends on (see spec). */
export const DEEP_AUDIT_MODEL = process.env.DEEP_AUDIT_MODEL || "claude-opus-4-8";

/** Adaptive thinking effort. "high" is the documented floor for agentic work. */
export const DEEP_AUDIT_EFFORT = process.env.DEEP_AUDIT_EFFORT || "high";

/** Total loop token ceiling per audit. Default = Agency tier (spec). */
export const DEEP_AUDIT_TOKEN_BUDGET = num(process.env.DEEP_AUDIT_TOKEN_BUDGET, 50000);

/** Max deterministic tool calls before the loop is forced to conclude. */
export const DEEP_AUDIT_MAX_TOOL_CALLS = num(process.env.DEEP_AUDIT_MAX_TOOL_CALLS, 12);
