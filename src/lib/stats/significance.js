/**
 * Statistical significance helpers for the rule engine.
 *
 * Purpose: stop rules firing on noise. A finding built on 8 conversions in a
 * single day is not trustworthy; the same rate over 30 days is. These helpers
 * gate findings on sample size and expose Wilson confidence intervals so rules
 * (and the narrative) can express how confident a rate estimate is.
 *
 * Pure functions, no I/O. Deterministic.
 */

// z-score for a 95% two-sided confidence interval.
const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion. More accurate than the
 * normal approximation at small n / extreme rates.
 *
 * @param {number} successes
 * @param {number} trials
 * @param {number} [z] z-score (default 95%)
 * @returns {{ rate, low, high, width } | null} null when trials <= 0
 */
export const wilsonInterval = (successes, trials, z = Z_95) => {
  const n = Number(trials);
  const x = Number(successes);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (!Number.isFinite(x) || x < 0) return null;

  const phat = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = phat + z2 / (2 * n);
  const margin =
    z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);

  const low = Math.max(0, (centre - margin) / denom);
  const high = Math.min(1, (centre + margin) / denom);

  return {
    rate: phat,
    low,
    high,
    width: high - low,
  };
};

// Minimum-sample gates per metric. Below these, a rate estimate is noise.
export const MIN_SAMPLE = {
  ctr: { denominatorMetric: "impressions", min: 1000 },
  cvr: { denominatorMetric: "clicks", min: 100 },
  cpa: { denominatorMetric: "conversions", min: 10 },
  cpr: { denominatorMetric: "results", min: 10 },
  roas: { denominatorMetric: "conversions", min: 10 },
};

/**
 * Is a rate estimate statistically meaningful?
 *
 * @param {object} args
 * @param {string} args.metric  one of MIN_SAMPLE keys
 * @param {number} args.denominator  impressions/clicks/conversions as appropriate
 * @returns {{ significant: boolean, min: number, denominator: number, reason: string }}
 */
export const isSignificant = ({ metric, denominator }) => {
  const gate = MIN_SAMPLE[metric];
  const n = Number(denominator) || 0;
  if (!gate) {
    return { significant: n > 0, min: 0, denominator: n, reason: "no_gate" };
  }
  const significant = n >= gate.min;
  return {
    significant,
    min: gate.min,
    denominator: n,
    reason: significant ? "ok" : `below_min_${gate.denominatorMetric}`,
  };
};

/**
 * Composite sample gate for a finding. Combines spend / click / conversion
 * minimums and a "material spend" escape hatch: a finding may still surface
 * on a thin sample when the spend at stake is clearly material.
 *
 * @returns {{
 *   passed: boolean,         all minimums met
 *   materialSpend: boolean,  spend ≥ materialSpend
 *   surface: boolean,        passed OR materialSpend (recommended fire gate)
 *   confidence: "high"|"medium"|"low",
 *   sampleNote: string,      human-readable, safe to put in evidence
 *   gates: object
 * }}
 */
export const gateFinding = ({
  spend = 0,
  clicks = 0,
  conversions = 0,
  minSpend = 0,
  minClicks = 0,
  minConversions = 0,
  materialSpend = Infinity,
}) => {
  const s = Number(spend) || 0;
  const c = Number(clicks) || 0;
  const cv = Number(conversions) || 0;

  const checks = {
    spend: s >= minSpend,
    clicks: minClicks ? c >= minClicks : true,
    conversions: minConversions ? cv >= minConversions : true,
  };
  const passed = checks.spend && checks.clicks && checks.conversions;
  const isMaterial = s >= materialSpend;
  const failing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);

  return {
    passed,
    materialSpend: isMaterial,
    surface: passed || isMaterial,
    confidence: passed ? "high" : isMaterial ? "medium" : "low",
    sampleNote: passed
      ? "sufficient sample"
      : isMaterial
        ? `low sample but material spend ($${Math.round(s).toLocaleString()})`
        : `low sample (${failing.join(", ") || "insufficient"})`,
    gates: { minSpend, minClicks, minConversions, materialSpend },
  };
};

/**
 * Zero-conversion spend gate: is a zero-conversion verdict trustworthy?
 * Needs either enough clicks to expect a conversion, or material spend.
 */
export const zeroConversionConfident = ({ spend = 0, clicks = 0, materialSpend = 500 }) => {
  const clicksOk = (Number(clicks) || 0) >= MIN_SAMPLE.cvr.min; // ≥100 clicks
  const material = (Number(spend) || 0) >= materialSpend;
  return {
    confident: clicksOk || material,
    confidence: clicksOk ? "high" : material ? "medium" : "low",
    sampleNote: clicksOk
      ? "sufficient clicks for a zero-conversion verdict"
      : material
        ? "material spend supports a zero-conversion verdict"
        : "insufficient clicks/spend — treat zero-conversion as directional",
  };
};

// Learning-phase thresholds — below these, platform delivery isn't optimized
// and metrics are volatile. Mirrors documented platform guidance.
export const LEARNING_PHASE = {
  META: { conversionsPerWeek: 50 },
  TIKTOK: { conversionsPerWeek: 50 },
  GOOGLE: { conversionsPer30d: 30 },
};

/**
 * Conservative learning-phase check.
 * @returns {{ inLearning: boolean, threshold: number|null }}
 */
export const inLearningPhase = ({ platform, conversionsPerWeek, conversionsPer30d }) => {
  const cfg = LEARNING_PHASE[platform];
  if (!cfg) return { inLearning: false, threshold: null };
  if (cfg.conversionsPerWeek != null && conversionsPerWeek != null) {
    return {
      inLearning: conversionsPerWeek < cfg.conversionsPerWeek,
      threshold: cfg.conversionsPerWeek,
    };
  }
  if (cfg.conversionsPer30d != null && conversionsPer30d != null) {
    return {
      inLearning: conversionsPer30d < cfg.conversionsPer30d,
      threshold: cfg.conversionsPer30d,
    };
  }
  return { inLearning: false, threshold: null };
};
