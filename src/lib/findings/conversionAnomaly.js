/**
 * Conversion-tracking anomaly detection.
 *
 * The failure mode this catches: an entity (usually a campaign) reports
 * conversions so implausibly CHEAP — relative to a robust peer baseline — and so
 * VOLUMINOUS that the "conversions" are almost certainly a misfired or mismatched
 * conversion event, not genuine results. The canonical example is a Meta
 * click-to-chat / WhatsApp button tap being counted as a "website lead": 3,000+
 * "leads" at a tenth of every other campaign's cost.
 *
 * Why it needs its own gate (the trust layer doesn't cover it): the trust layer
 * is asymmetric — it guards the EXPENSIVE direction (suppresses implausibly-high
 * per-segment CPAs that are really attribution artifacts). An implausibly-CHEAP
 * conversion sails straight through and does two kinds of damage:
 *   1. It looks like the best performer, so the engine recommends SCALING the
 *      broken campaign — the worst possible advice.
 *   2. Its fake conversions collapse the blended account baseline CPA, so every
 *      genuinely healthy campaign gets flagged as "over baseline" and the real
 *      offenders are masked.
 *
 * Detection is purely RATIO-BASED and therefore currency-agnostic — no absolute
 * cost thresholds. It is deliberately conservative: it only fires when an entity
 * is both far cheaper than its peers AND large enough to materially distort the
 * account baseline, so a genuinely efficient small campaign is never flagged.
 *
 * Pure + deterministic.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round = (v) => Math.round(num(v) * 100) / 100;

/** Median of a numeric array (robust to the anomaly itself). */
const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Normalised entity key for cross-referencing against report rows / records. */
export const normName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

// Need enough converting peers for the median to be a trustworthy baseline. With
// only 2-3 campaigns we cannot tell an anomaly from a legitimately cheap account.
const MIN_CONVERTING_ENTITIES = 4;
// The entity's CPA must be at least this many times cheaper than the peer median
// to be "implausibly" cheap rather than merely efficient.
const CHEAP_MULTIPLE = 5;
// ...and it must carry at least this share of the platform's conversions. A
// trivially small cheap campaign distorts nothing and does not warrant a CRITICAL.
const MIN_CONVERSION_SHARE = 0.15;
// Only fire when removing the anomaly shifts the blended baseline by at least this
// factor — i.e. the fake conversions are genuinely poisoning the baseline.
const MIN_BASELINE_DISTORTION = 1.3;

/**
 * @param {Array<{name, spend, conversions}>} entities  campaign-level rows
 * @returns {null | {
 *   anomalies: Array<{name, normName, spend, conversions, cpa, peerMultiple}>,
 *   reportedSpend, reportedConversions, reportedBaselineCpa,
 *   trustedSpend, trustedConversions, trustedBaselineCpa,
 *   peerMedianCpa, distortion
 * }}
 */
export const detectConversionAnomalies = (entities = []) => {
  const rows = (entities || [])
    .map((e) => {
      const spend = num(e.spend);
      const conversions = num(e.conversions ?? e.results);
      return {
        name: e.name,
        spend,
        conversions,
        cpa: conversions > 0 ? spend / conversions : null,
      };
    })
    .filter((e) => e.spend > 0);

  const converting = rows.filter((e) => e.conversions > 0 && e.cpa != null);
  if (converting.length < MIN_CONVERTING_ENTITIES) return null;

  const reportedSpend = rows.reduce((a, e) => a + e.spend, 0);
  const reportedConversions = rows.reduce((a, e) => a + e.conversions, 0);
  if (reportedConversions <= 0) return null;
  const reportedBaselineCpa = reportedSpend / reportedConversions;

  // Robust peer baseline: the median campaign CPA is unmoved by one cheap outlier.
  const peerMedianCpa = median(converting.map((e) => e.cpa));
  if (peerMedianCpa == null || peerMedianCpa <= 0) return null;

  const anomalies = converting
    .filter(
      (e) =>
        e.cpa < peerMedianCpa / CHEAP_MULTIPLE &&
        e.conversions / reportedConversions >= MIN_CONVERSION_SHARE
    )
    .map((e) => ({
      name: e.name,
      normName: normName(e.name),
      spend: round(e.spend),
      conversions: e.conversions,
      cpa: round(e.cpa),
      peerMultiple: round(peerMedianCpa / e.cpa),
    }));

  if (!anomalies.length) return null;

  const anomalySpend = anomalies.reduce((a, e) => a + e.spend, 0);
  const anomalyConversions = anomalies.reduce((a, e) => a + e.conversions, 0);
  const trustedSpend = reportedSpend - anomalySpend;
  const trustedConversions = reportedConversions - anomalyConversions;
  // Removing the anomaly must leave a real, still-converting account behind.
  if (trustedConversions <= 0 || trustedSpend <= 0) return null;
  const trustedBaselineCpa = trustedSpend / trustedConversions;

  const distortion = trustedBaselineCpa / reportedBaselineCpa;
  if (distortion < MIN_BASELINE_DISTORTION) return null;

  return {
    anomalies,
    reportedSpend: round(reportedSpend),
    reportedConversions,
    reportedBaselineCpa: round(reportedBaselineCpa),
    trustedSpend: round(trustedSpend),
    trustedConversions,
    trustedBaselineCpa: round(trustedBaselineCpa),
    peerMedianCpa: round(peerMedianCpa),
    distortion: round(distortion),
  };
};
