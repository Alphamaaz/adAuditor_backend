/**
 * Leverage-based finding prioritization.
 *
 * The original ordering ranked findings by raw recoverable dollars. That buries
 * rate-severe problems carried on lower-spend campaigns — e.g. a paused campaign
 * running at 15× the account CPA — beneath larger-dollar but mild issues such as
 * a day-of-week bid tweak worth ~3% of spend. A competing expert audit led with
 * the 15× targeting error and ranked the day-parting tweak last; our engine did
 * the reverse purely because of dollar magnitude.
 *
 * Leverage fixes that. Severity dominates (it already encodes rate / structural
 * gravity: the engine reserves CRITICAL for things like ≥5× CPA overages, ≥30%
 * segment waste, or missing conversion tracking), then confidence, then the
 * recoverable-dollar magnitude orders findings *within* a severity band. A big
 * MEDIUM can still outrank a small MEDIUM, but it can no longer outrank a
 * CRITICAL.
 *
 * Pure + deterministic so the deterministic engine, the evidence packet, and the
 * Deep Audit tool layer all rank findings identically.
 */

import { parseMoney } from "../money.js";

const SEVERITY_WEIGHT = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Parse the leading money magnitude from an estimatedImpact string.
 * "PKR 4,280 in waste…" → 4280. Returns 0 when none is present. Currency
 * coverage comes from the shared `money.js` vocabulary (global markets), so it
 * can never drift from the report / trust-layer parsers.
 */
export const parseImpactDollars = (impact) =>
  typeof impact === "string" ? parseMoney(impact) : 0;

/**
 * Is this finding's evidence flagged as thin / not statistically significant?
 * Such findings are demoted within their severity band so a low-sample guess
 * never leads the report.
 */
export const isLowConfidence = (finding) => {
  const ev = finding?.evidence || {};
  if (ev.significant === false) return true;
  if (ev.minSamplePassed === false && ev.confidence && ev.confidence !== "high") {
    return true;
  }
  return String(ev.sampleNote || "").toLowerCase().startsWith("low sample");
};

/**
 * Does this finding describe a hard delivery block (a disapproved ad, a billing
 * hold, a disabled account)? Such findings lead within their severity band: no
 * efficiency change can outperform simply restoring delivery, so a blocking
 * CRITICAL must rank above an equally-severe but merely-inefficient one — even
 * when the latter carries more recoverable dollars.
 */
export const blocksDelivery = (finding) => finding?.evidence?.blocksDelivery === true;

/**
 * Composite leverage score — higher is more important. Banded so that:
 *   severity   → primary     (CRITICAL always above HIGH above MEDIUM above LOW)
 *   confidence → secondary   (confident findings above thin-sample ones)
 *   blocking   → tertiary    (a delivery block leads its severity band)
 *   dollars    → quaternary  (orders findings within a band; capped so a single
 *                             huge figure can never jump a higher band)
 */
export const leverageScore = (finding) => {
  const sev = SEVERITY_WEIGHT[finding?.severity] || 1;
  const confident = isLowConfidence(finding) ? 0 : 1;
  const blocking = blocksDelivery(finding) ? 1 : 0;
  const dollars = Math.min(parseImpactDollars(finding?.estimatedImpact), 1e10);
  return sev * 1e15 + confident * 1e14 + blocking * 1e13 + dollars;
};

/** Array.sort comparator: most important finding first. */
export const byLeverageDesc = (a, b) => leverageScore(b) - leverageScore(a);
