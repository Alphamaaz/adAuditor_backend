/**
 * Segment contribution analysis.
 *
 * Given breakdown rows for one dimension (e.g. Meta age brackets), compute
 * per-segment efficiency and rank segments by wasted spend versus the
 * account/platform baseline. This is the engine behind segment-level insights
 * like "the 45-54 bracket burned $206 for 2 results."
 *
 * Pure code. The LLM never computes waste — it narrates this output.
 */

import { isSignificant } from "../stats/significance.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Get conversions for a record, tolerating `results` (Meta messaging/leads)
 * or `conversions` (Google/TikTok).
 */
const recordConversions = (r) => num(r.conversions ?? r.results);

/**
 * Per-segment rollup. Each input row: { segment, spend, impressions, clicks,
 * conversions|results }.
 */
export const summarizeSegments = (records = []) =>
  records
    .filter((r) => r && (r.segment != null))
    .map((r) => {
      const spend = num(r.spend);
      const conversions = recordConversions(r);
      const clicks = num(r.clicks);
      return {
        segment: String(r.segment),
        spend: round(spend),
        impressions: num(r.impressions),
        clicks,
        conversions,
        cpa: conversions > 0 ? round(spend / conversions) : null,
      };
    });

/**
 * Compute the platform baseline CPA from totals (spend / conversions).
 */
export const baselineCpa = ({ spend, conversions }) => {
  const s = num(spend);
  const c = num(conversions);
  return c > 0 ? round(s / c) : null;
};

// A segment carrying at least this share of the dimension's spend IS the
// account, not a "waste" pocket — there is nothing to reallocate it to. Flagging
// it (e.g. "mobile app, 99.7% of spend, is wasting…") and recommending exclusion
// would switch the account off. The waste, if any, surfaces via account- and
// campaign-level findings instead.
const DOMINANCE_SHARE = 0.9;

// A segment whose CPA is wildly beyond the account baseline isn't "expensive" —
// it's a breakdown where the platform failed to attribute the conversions (Meta
// region/DMA breakdowns are notorious for this). Real per-segment dispersion is
// a few× baseline; a 200× "CPA" means the conversions exist but landed on the
// account, not this row. Treat it as unmeasured, never as recoverable waste.
const IMPLAUSIBLE_CPA_MULTIPLE = 12;

// The same artifact seen via shares: a segment holding a DOMINANT slice of the
// dimension's SPEND but a microscopic slice of its CONVERSIONS is under-
// attributed, not wasteful. (Punjab: ~47% of spend, <1% of attributed
// conversions → its results were dropped by the region breakdown.) The share
// floor is high on purpose: a smaller (~20%) zero-conversion segment — e.g.
// Audience Network — is plausibly genuinely wasteful and SHOULD still flag. Only
// when a segment is ~half the spend yet barely converts, on an account that
// converts healthily overall, is it certainly an attribution drop, not waste.
const MISATTRIB_MIN_SHARE = 0.4;
const MISATTRIB_RATIO = 0.1; // conversion-share must be ≥10% of spend-share

// The share-based under-attribution guard applies ONLY to geographic breakdowns
// (region/country/DMA/city). Those are the dimensions platforms under-attribute;
// device/placement/age/gender attribute reliably, so a dominant zero-conversion
// segment there (e.g. mobile converts nothing while desktop does) is a real
// "exclude it" finding, not an artifact. (The implausible-CPA ceiling below
// still guards every dimension against a physically-impossible per-segment CPA.)
const GEO_DIMENSION_RX = /region|geo|countr|dma|city|state|province|location|metro|area/i;

/**
 * Analyze one dimension's segments against a baseline CPA.
 *
 * Waste model:
 *   - zero-conversion segment with spend ≥ minSpend → full spend is wasted
 *   - segment CPA worse than baseline → excess = spend × (1 − baseline/segCpa)
 *   - otherwise → 0
 *
 * Two guards keep this honest (both were live false-positive sources):
 *   - ATTRIBUTION: if the account converts (baseCpa != null) but this whole
 *     dimension reports zero conversions, Meta is not attributing results at
 *     this breakdown (e.g. conversations are "Not available" by gender). A
 *     zero-conversion segment here is unmeasured, not wasteful — never flag it.
 *   - DOMINANCE: a segment that is ~all of the dimension's spend is the account
 *     itself; it cannot be "excluded and reallocated".
 *
 * Significance: a segment's waste is "confident" only when it clears the
 * sample gate (enough clicks for a zero-conv verdict, or enough conversions
 * for a CPA verdict). Low-sample segments are still returned but flagged.
 *
 * @returns {{ dimension, baselineCpa, attributed, segments: [...], totalWaste, worst }}
 */
export const analyzeDimension = ({
  dimension,
  records,
  baselineCpa: baseCpa,
  minSpend = 50,
}) => {
  const summarized = summarizeSegments(records);

  const dimensionSpend = summarized.reduce((sum, s) => sum + s.spend, 0);
  const dimensionConversions = summarized.reduce((sum, s) => sum + s.conversions, 0);
  // Attribution is available at this breakdown when the dimension itself reports
  // conversions. If the account converts but this dimension shows none, results
  // are simply not attributed here — we must not read that as "all wasted".
  const attributed = dimensionConversions > 0 || baseCpa == null;

  const segments = summarized.map((s) => {
    let wastedSpend = 0;
    let reason = "ok";

    const spendShare = dimensionSpend > 0 ? s.spend / dimensionSpend : 0;
    const conversionShare = dimensionConversions > 0 ? s.conversions / dimensionConversions : 0;
    // Dominance only means something when there are multiple segments to weigh
    // against. A single-segment dimension (a partial breakdown, or a day-parting
    // slice) is 100% of itself by construction — not a sign it's the account.
    const isDominant = summarized.length >= 2 && spendShare >= DOMINANCE_SHARE;
    // A large-spend GEO segment whose conversions are missing relative to that
    // spend → the breakdown under-attributed its results (the Punjab artifact).
    // Geo-only; other dimensions attribute reliably.
    const isUnderAttributed =
      GEO_DIMENSION_RX.test(String(dimension || "")) &&
      attributed &&
      summarized.length >= 2 &&
      spendShare >= MISATTRIB_MIN_SHARE &&
      conversionShare < spendShare * MISATTRIB_RATIO;
    // An impossible CPA = the same attribution artifact, caught per-segment.
    const isImplausibleCpa = baseCpa != null && s.cpa != null && s.cpa > baseCpa * IMPLAUSIBLE_CPA_MULTIPLE;

    if (isDominant) {
      reason = "dominant_segment"; // the account itself — not waste
    } else if (!attributed) {
      reason = "unattributed"; // dimension carries no result attribution
    } else if (isUnderAttributed) {
      reason = "under_attributed"; // big spend, conversions dropped by the breakdown
    } else if (isImplausibleCpa) {
      reason = "implausible_cpa"; // CPA so far past baseline it must be unattributed
    } else if (s.conversions === 0 && s.spend >= minSpend) {
      wastedSpend = s.spend;
      reason = "zero_conversions";
    } else if (baseCpa != null && s.cpa != null && s.cpa > baseCpa) {
      wastedSpend = round(s.spend * (1 - baseCpa / s.cpa));
      reason = "worse_than_baseline";
    }

    // Confidence: zero-conv verdict needs enough clicks; CPA verdict needs
    // enough conversions.
    const sig =
      s.conversions === 0
        ? isSignificant({ metric: "cvr", denominator: s.clicks })
        : isSignificant({ metric: "cpa", denominator: s.conversions });

    return {
      ...s,
      dimension,
      baselineCpa: baseCpa,
      spendShare: round(spendShare, 4),
      wastedSpend,
      reason,
      significant: sig.significant,
      sampleNote: sig.significant
        ? "sufficient sample"
        : `low sample (${sig.reason})`,
    };
  });

  const ranked = [...segments].sort((a, b) => b.wastedSpend - a.wastedSpend);
  const totalWaste = round(
    ranked.reduce((sum, s) => sum + (s.significant ? s.wastedSpend : 0), 0)
  );

  return {
    dimension,
    baselineCpa: baseCpa,
    attributed,
    segments: ranked,
    totalWaste,
    // Worst significant segment with real waste — the headline.
    worst: ranked.find((s) => s.significant && s.wastedSpend > 0) || null,
  };
};

export const __test__ = { recordConversions, round };
