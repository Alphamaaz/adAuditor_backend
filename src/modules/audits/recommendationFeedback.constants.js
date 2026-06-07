/**
 * Canonical vocabulary for RecommendationFeedback.rating.
 *
 * RecommendationFeedback.rating is a free-form String column in the Prisma
 * schema. To keep analytics queries (which group by these values) stable,
 * EVERY code path that reads or writes a rating must use these constants —
 * never raw string literals.
 *
 * If you add a new rating, you must:
 *   1. Add it here under the appropriate semantic bucket
 *   2. Update any analytics queries that should include/exclude it
 *   3. Update docs/RULE_ENGINE_ARCHITECTURE.md §Rule Telemetry section
 */

// Positive: customer indicates the finding was useful + acted on it.
export const RATING_RESOLVED = "RESOLVED";
export const RATING_FIXED = "FIXED";
export const RATING_HELPFUL = "HELPFUL";

// Negative: customer indicates the finding was not useful.
export const RATING_DISMISSED = "DISMISSED";
export const RATING_NOT_HELPFUL = "NOT_HELPFUL";

// Neutral / deferred.
export const RATING_SNOOZED = "SNOOZED";

export const RATING_VALUES = Object.freeze([
  RATING_RESOLVED,
  RATING_FIXED,
  RATING_HELPFUL,
  RATING_DISMISSED,
  RATING_NOT_HELPFUL,
  RATING_SNOOZED,
]);

export const RESOLVED_RATINGS = Object.freeze([
  RATING_RESOLVED,
  RATING_FIXED,
  RATING_HELPFUL,
]);

export const DISMISSED_RATINGS = Object.freeze([
  RATING_DISMISSED,
  RATING_NOT_HELPFUL,
]);

export const isResolvedRating = (rating) => RESOLVED_RATINGS.includes(rating);
export const isDismissedRating = (rating) => DISMISSED_RATINGS.includes(rating);
export const isValidRating = (rating) => RATING_VALUES.includes(rating);
