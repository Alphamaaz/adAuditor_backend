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

/**
 * Analyze one dimension's segments against a baseline CPA.
 *
 * Waste model:
 *   - zero-conversion segment with spend ≥ minSpend → full spend is wasted
 *   - segment CPA worse than baseline → excess = spend × (1 − baseline/segCpa)
 *   - otherwise → 0
 *
 * Significance: a segment's waste is "confident" only when it clears the
 * sample gate (enough clicks for a zero-conv verdict, or enough conversions
 * for a CPA verdict). Low-sample segments are still returned but flagged.
 *
 * @returns {{ dimension, baselineCpa, segments: [...], totalWaste, worst }}
 */
export const analyzeDimension = ({
  dimension,
  records,
  baselineCpa: baseCpa,
  minSpend = 50,
}) => {
  const summarized = summarizeSegments(records);

  const segments = summarized.map((s) => {
    let wastedSpend = 0;
    let reason = "ok";

    if (s.conversions === 0 && s.spend >= minSpend) {
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
    segments: ranked,
    totalWaste,
    // Worst significant segment with real waste — the headline.
    worst: ranked.find((s) => s.significant && s.wastedSpend > 0) || null,
  };
};

export const __test__ = { recordConversions, round };
