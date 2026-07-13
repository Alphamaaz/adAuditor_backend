/**
 * AI Analyst — configuration. (spec: docs/AI_ANALYST_SPEC.md)
 *
 * ON by default (set ANALYST_ENABLED=false to disable). The analyst can only
 * add to a report — every failure path degrades to the deterministic pipeline —
 * so the flag is a cost switch, not a safety switch.
 */

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const isAnalystEnabled = () =>
  String(process.env.ANALYST_ENABLED ?? "true").toLowerCase() !== "false";

/** Opus 4.8 by default; drop to claude-sonnet-5 for cheaper tiers. */
export const ANALYST_MODEL = process.env.ANALYST_MODEL || "claude-opus-4-8";

/** Budget-tier model — used for free/starter plans unless overridden. */
export const ANALYST_MODEL_BUDGET =
  process.env.ANALYST_MODEL_BUDGET || "claude-sonnet-5";

/**
 * Per-plan model selection (spec §7): starter and free tiers run the budget
 * model; pro/agency (and unknown slugs, conservatively) run the flagship.
 * An explicit ANALYST_MODEL env overrides for every tier.
 */
export const resolveAnalystModel = (planSlug) => {
  if (process.env.ANALYST_MODEL) return process.env.ANALYST_MODEL;
  const slug = String(planSlug || "").toLowerCase();
  if (slug === "free" || slug === "starter") return ANALYST_MODEL_BUDGET;
  return ANALYST_MODEL;
};

export const ANALYST_EFFORT = process.env.ANALYST_EFFORT || "high";

/** Input-token budget for the serialized dataset (prompt overhead is on top). */
export const ANALYST_MAX_DATASET_TOKENS = num(
  process.env.ANALYST_MAX_DATASET_TOKENS,
  150000
);

/** Output ceiling — the structured report plus thinking headroom. */
export const ANALYST_MAX_OUTPUT_TOKENS = num(
  process.env.ANALYST_MAX_OUTPUT_TOKENS,
  64000
);

/**
 * One extra small model call when the report states numbers without a
 * supporting fact: the model is asked to attach facts BEFORE verification
 * deletes the sentences. Off = current single-shot behavior.
 */
export const isAnalystProseRepairEnabled = () =>
  String(process.env.ANALYST_PROSE_REPAIR ?? "true").toLowerCase() !== "false";
