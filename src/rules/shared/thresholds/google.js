/**
 * Google-platform rule thresholds.
 *
 * Every numeric/string constant a Google rule uses lives here. Rules MUST
 * import these — no inline magic numbers. This is the single source of
 * truth for tuning Google detection sensitivity.
 *
 * Tuning principles:
 *   - Thresholds should be defensible by reference to industry norms
 *     or per-rule documented rationale.
 *   - Changing a threshold is a MINOR or MAJOR semver bump on every rule
 *     that consumes it (depending on whether more or fewer findings result).
 */

export const GOOGLE_SEARCH_TERM_WASTE = Object.freeze({
  // Per-term spend floor. Below this, we ignore the term as exploration noise.
  MIN_SPEND_PER_TERM: 20,
  // Per-term click floor. <10 clicks is not statistically meaningful.
  MIN_CLICKS_PER_TERM: 10,
  // Minimum total Google search-term spend before the rule is even evaluated.
  MIN_TOTAL_SEARCH_TERM_SPEND: 500,
  // Aggregate share thresholds for severity.
  AGGREGATE_SHARE_FIRE: 0.05, // 5% — fire at all
  AGGREGATE_SHARE_HIGH: 0.10, // 10% — HIGH
  AGGREGATE_SHARE_CRITICAL: 0.20, // 20% — CRITICAL
  // Industry-typical share of identified waste recoverable via negative keywords.
  RECOVERY_FACTOR: 0.8,
  // Examples returned with finding (top N by spend).
  EXAMPLES_COUNT: 5,
});

export const GOOGLE_BRAND_SEPARATION = Object.freeze({
  // Mixed-spend floor — below this, mixing is noise, not a structural issue.
  MIN_MIXED_SPEND: 50,
  // Min keywords on the "wrong side" before firing (avoids single-keyword false positive).
  MIN_MIXED_KEYWORDS: 2,
  EXAMPLES_COUNT: 5,
});
