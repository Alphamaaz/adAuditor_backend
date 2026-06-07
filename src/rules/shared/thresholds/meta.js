/**
 * Meta-platform rule thresholds.
 * See ./google.js for the contract.
 */

export const META_AUDIENCE_OVERLAP = Object.freeze({
  // Per-ad-set frequency threshold suggesting overlap-driven saturation.
  // 3.0 is the inflection where Meta's auction starts to show fatigue.
  OVERLAP_FREQ: 3.0,
  // Per-ad-set spend floor for the ad set to count as "active enough".
  MIN_ADSET_SPEND: 100,
  // Minimum overlapping ad sets per campaign before firing.
  MIN_OVERLAP_ADSETS_PER_CAMPAIGN: 2,
  // Min ad sets per campaign for the rule to consider it at all (single
  // ad set can't overlap with itself).
  MIN_ADSETS_PER_CAMPAIGN: 2,
  // Recovery factor — conservative midpoint of typical 5-15% audience-overlap
  // efficiency loss.
  RECOVERY_FACTOR: 0.10,
  // Severity escalation when ≥ N overlapping ad sets in one campaign.
  HIGH_SEVERITY_AT: 3,
  EXAMPLES_COUNT: 5,
});

export const META_CAPI_MATCH = Object.freeze({
  // Match-rate bands for severity.
  HIGH_SEVERITY_MAX_MATCH_RATE: 70, // < 70% = HIGH
  MEDIUM_SEVERITY_MAX_MATCH_RATE: 85, // 70-85% = MEDIUM
  // Intake answer keys.
  STATUS_KEY: "M_CAPI_STATUS",
  MATCH_RATE_KEY: "M_CAPI_MATCH_RATE",
  // Canonical status values.
  STATUS_DEPLOYED: "deployed",
  STATUS_NOT_DEPLOYED: "not_deployed",
  STATUS_UNSURE: "unsure",
});
