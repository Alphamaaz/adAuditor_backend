/**
 * Finding-trust validation layer — ONE general gate every quantified finding
 * passes through before it may assert a recoverable number, regardless of
 * platform (Meta / Google / TikTok) or rule.
 *
 * Why this exists: every recurring false positive had the SAME root cause — the
 * engine asserting a confident dollar claim from a data slice it shouldn't fully
 * trust (under-attributed breakdowns, low sample, an implausible per-segment CPA,
 * or a slice that IS the whole account). Fixing those one rule at a time never
 * converged because the next client's account skews a slightly different way.
 * This replaces the scattered per-rule guards with one defensive-by-default
 * backstop plus a single overlap-reconciliation pass.
 *
 * Two responsibilities:
 *   1. SINGLE-FINDING SAFETY (per finding, all rules):
 *        - PLAUSIBILITY    — a per-segment CPA wildly past baseline, or a claim
 *                            bigger than the segment even spent, is an attribution
 *                            artifact, not waste → SUPPRESS.
 *        - ATTRIBUTION     — a geo/breakdown segment holding a dominant slice of
 *                            spend but a microscopic slice of conversions had its
 *                            results dropped by the breakdown → SUPPRESS.
 *        - SAMPLE          — a finding flagged not statistically significant must
 *                            not assert a hard number → DIRECTIONAL (hedge).
 *        - MATERIALITY     — a segment that is ~the whole account has nothing to
 *                            reallocate to → SUPPRESS.
 *      Verdict: CONFIDENT (assert) · DIRECTIONAL (show, hedge, no hard $) ·
 *      SUPPRESS (drop). Defensive by default: when unsure it downgrades rather
 *      than asserting a number that might be wrong.
 *
 *   2. OVERLAP RECONCILIATION (across findings):
 *        the same wasted spend surfaces as campaign + audience + geo + device
 *        findings. partitionRecoverable assigns each a NET, non-overlapping
 *        recoverable; overlapping ("secondary") findings are reframed so they no
 *        longer claim an additive dollar. This is what stopped real accounts from
 *        reporting 60-141% of total spend as "recoverable".
 *
 * Pure + deterministic. Mutates finding copies in place and returns the kept set.
 */

import { isLowConfidence } from "./priority.js";
import { partitionRecoverable } from "./recoverable.js";
import { parseMoney } from "../money.js";

// A per-segment CPA this many times the account baseline is not "expensive" — the
// conversions exist but landed on the account, not this breakdown row (Meta
// region/DMA breakdowns are notorious). Mirrors the SEG-WASTE guard so geo and
// other rule paths get the same protection.
const IMPLAUSIBLE_CPA_MULTIPLE = 12;
// A segment that is ~all of the dimension/platform spend IS the account — there
// is nothing to reallocate it to.
const DOMINANCE_SHARE = 0.9;
// Geographic breakdowns are the ones platforms under-attribute. A geo segment
// holding ≥40% of spend but <10%-of-its-spend-share in conversions had its
// results dropped by the breakdown (the "Punjab" artifact).
const GEO_DIMENSION_RX = /region|geo|countr|dma|city|state|province|location|metro|area/i;
const UNDER_ATTRIB_MIN_SHARE = 0.4;
const UNDER_ATTRIB_RATIO = 0.1;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Per-platform spend/conversions, for share-based materiality/attribution. */
export const buildPlatformContext = (dataset) => {
  const ctx = {};
  const platforms = dataset?.summary?.platforms || {};
  for (const [p, v] of Object.entries(platforms)) {
    ctx[p] = { spend: num(v?.spend), conversions: num(v?.conversions) };
  }
  return ctx;
};

// The leading currency token in estimatedImpact is the asserted recoverable.
// Uses the shared global currency vocabulary (src/lib/money.js).
const recoverableText = (finding) => parseMoney(finding?.estimatedImpact || "");

/**
 * Single-finding verdict. Only ever acts to PREVENT a confidently-wrong number;
 * qualitative findings (no recoverable claim, no segment evidence) pass through
 * untouched as CONFIDENT.
 *
 * @returns {{ verdict: 'CONFIDENT'|'DIRECTIONAL'|'SUPPRESS', reasons: string[] }}
 */
export const assessFinding = (finding, ctx = {}) => {
  const ev = finding?.evidence || {};
  const reasons = [];
  const claim = recoverableText(finding);
  const segCpa = num(ev.segmentCpa);
  const baseCpa = num(ev.baselineCpa);
  const platform = ctx[finding?.platform] || null;

  // PLAUSIBILITY — implausible per-segment CPA = unattributed, not recoverable.
  if (segCpa > 0 && baseCpa > 0 && segCpa > baseCpa * IMPLAUSIBLE_CPA_MULTIPLE) {
    reasons.push(
      `segment CPA ${Math.round(segCpa)} is ${Math.round(segCpa / baseCpa)}× the ${Math.round(baseCpa)} baseline — conversions were almost certainly dropped by this breakdown, not genuinely this expensive`
    );
    return { verdict: "SUPPRESS", reasons };
  }
  // PLAUSIBILITY — a claim larger than the segment even spent is impossible.
  if (claim > 0 && num(ev.spend) > 0 && claim > num(ev.spend) * 1.05) {
    reasons.push(`recoverable claim (${Math.round(claim)}) exceeds the segment's own spend (${Math.round(ev.spend)})`);
    return { verdict: "SUPPRESS", reasons };
  }

  // ATTRIBUTION — geo breakdown under-attributing its conversions.
  if (
    GEO_DIMENSION_RX.test(String(ev.dimension || "")) &&
    platform &&
    platform.conversions > 0 &&
    num(ev.spend) > 0
  ) {
    const spendShare = ev.spend / platform.spend;
    const convShare = num(ev.conversions) / platform.conversions;
    if (spendShare >= UNDER_ATTRIB_MIN_SHARE && convShare < spendShare * UNDER_ATTRIB_RATIO) {
      reasons.push(
        `geo segment holds ${Math.round(spendShare * 100)}% of spend but only ${Math.round(convShare * 100)}% of conversions — the breakdown under-attributed its results`
      );
      return { verdict: "SUPPRESS", reasons };
    }
  }

  // MATERIALITY — a segment that is ~the whole platform has nothing to move to.
  if (claim > 0 && platform && platform.spend > 0 && num(ev.spend) / platform.spend >= DOMINANCE_SHARE) {
    reasons.push(`segment is ${Math.round((ev.spend / platform.spend) * 100)}% of platform spend — it IS the account, nothing to reallocate to`);
    return { verdict: "SUPPRESS", reasons };
  }

  // SAMPLE — a thin-sample MEDIUM/LOW rate-guess may surface, but not with a hard
  // number. CRITICAL/HIGH findings are NOT hedged here: severity already encodes
  // structural gravity (≥5× CPA, ≥30% waste, delivery blocks), and a large
  // spend-side blow-up is real even when the bad entity has few conversions —
  // silencing it would bury exactly the findings that matter most. The existing
  // leverage ranking already demotes low-confidence findings within their band.
  if (
    claim > 0 &&
    isLowConfidence(finding) &&
    finding.severity !== "CRITICAL" &&
    finding.severity !== "HIGH"
  ) {
    reasons.push("sample too thin to assert a hard recoverable figure");
    return { verdict: "DIRECTIONAL", reasons };
  }

  return { verdict: "CONFIDENT", reasons };
};

/** Strip the hard dollar from a hedged finding and mark it directional. */
const hedgeFinding = (finding) => {
  const ev = finding.evidence || {};
  const cpa = ev.segmentCpaFormatted || (ev.segmentCpa != null ? String(ev.segmentCpa) : null);
  const base = ev.baselineCpaFormatted || (ev.baselineCpa != null ? String(ev.baselineCpa) : null);
  const seg = ev.segment ? `${ev.segment} ${ev.dimension || "segment"}` : "this segment";
  finding.estimatedImpact =
    `Directional only — ${seg}${cpa && base ? ` appears to run at ${cpa} vs the ${base} baseline` : " appears to underperform"}, ` +
    `but the sample is too thin to quantify a reliable recoverable figure. Verify in the platform over a longer window before acting.`;
  if (Array.isArray(finding.fixSteps)) {
    finding.fixSteps = [
      "Confirm the pattern over a longer reporting window before reallocating budget.",
      ...finding.fixSteps.filter((s) => !/recover|reallocat/i.test(s)),
    ];
  }
};

/** Reframe an overlapping ("secondary") finding so it no longer claims an additive dollar. */
const reframeSecondary = (finding) => {
  const ev = finding.evidence || {};
  const cpa = ev.segmentCpaFormatted;
  const base = ev.baselineCpaFormatted;
  const spend = ev.spendFormatted;
  const seg = ev.segment ? `The ${ev.segment} ${ev.dimension || "segment"}` : "This segment";
  const lensClause =
    cpa && base
      ? `has a ${cpa} cost per result vs the account's ${base} baseline cost per result${spend ? `, on ${spend} of spend` : ""}`
      : "has a higher cost per result than the account baseline";
  finding.estimatedImpact =
    `${seg} ${lensClause}. This is the ${ev.dimension || "audience"} view of an inefficiency the campaign-level finding already counts — acting here recovers part of that same spend, not additional money.`;
  // Neutralise the title so it can't be mentally summed with the primary's dollar.
  // (Carries no standalone recoverable figure — the dimension lens, not a number.)
  if (ev.segment) {
    finding.title = `The ${ev.segment} ${ev.dimension || "segment"} is part of the same inefficiency (${ev.dimension || "audience"} view)`;
  }
};

/**
 * Apply the trust layer to a finding list.
 * @returns the kept findings (suppressed ones dropped), each with
 *   evidence.netRecoverable + evidence.trust set.
 */
export const applyTrustLayer = ({ findings, dataset } = {}) => {
  const ctx = buildPlatformContext(dataset);

  // 1. Single-finding safety pass.
  const kept = [];
  for (const f of findings || []) {
    const { verdict, reasons } = assessFinding(f, ctx);
    if (verdict === "SUPPRESS") continue; // a wrong number is worse than silence
    if (verdict === "DIRECTIONAL") hedgeFinding(f);
    f.evidence = { ...(f.evidence || {}) };
    f.evidence.trust = { verdict, reasons };
    if (verdict === "DIRECTIONAL") {
      f.evidence.confidence = "directional";
      f.evidence.significant = false;
    }
    kept.push(f);
  }

  // 2. Overlap reconciliation. Delivery blocks and diagnostics are restorable
  // upside / explanations, NOT recoverable waste — excluded from the pool (and
  // pinned to net 0) exactly as the report headline excludes them.
  const accountSpend = num(dataset?.summary?.totals?.spend);
  const poolable = kept.filter(
    (f) =>
      f.evidence?.blocksDelivery !== true &&
      f.evidence?.diagnostic !== true &&
      f.evidence?.advisory !== true
  );
  const { assignments } = partitionRecoverable(poolable, { accountSpend });
  const byFinding = new Map(assignments.map((a) => [a.finding, a]));

  for (const f of kept) {
    const a = byFinding.get(f);
    const role = a ? a.role : "none";
    f.evidence.netRecoverable = a ? a.net : 0;
    f.evidence.trust = { ...f.evidence.trust, role, net: f.evidence.netRecoverable };
    if (role === "secondary") reframeSecondary(f);
  }

  return kept;
};
