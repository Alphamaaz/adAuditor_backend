/**
 * Severity ladder helper.
 *
 * Given a value + ordered breakpoints, returns the highest severity whose
 * threshold the value meets. Use this instead of inline ternaries so
 * severity calibration is consistent across rules and visible at a glance.
 *
 * Example:
 *   pickSeverity(share, [
 *     [0.20, "CRITICAL"],
 *     [0.10, "HIGH"],
 *     [0.05, "MEDIUM"],
 *   ])
 *
 * Breakpoints must be sorted DESCENDING by threshold. Returns null when
 * value is below the lowest breakpoint.
 */
export const pickSeverity = (value, breakpoints) => {
  for (const [threshold, severity] of breakpoints) {
    if (value >= threshold) return severity;
  }
  return null;
};
