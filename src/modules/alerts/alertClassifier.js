import { parseImpactDollars } from "../../lib/findings/priority.js";

/**
 * Smart alert classification — decides what earns an *interruption* (an
 * immediate email) versus what rolls into the periodic digest, versus what
 * never alerts at all.
 *
 * The governing principle is "alert on CHANGE, not STATE": only findings that
 * are NEW since the previous audit are eligible. A finding that was already
 * present last time is "open/known" and must never re-alert — re-alerting on
 * the same issue every run is the #1 cause of alert fatigue. The previous-audit
 * comparison is therefore the throttle, for free.
 *
 * Pure + deterministic.
 */

// Rules whose mere presence is a measurement-integrity emergency — tracking is
// the foundation of every number in the account, so a break is always urgent.
const ALWAYS_IMMEDIATE_RULES = new Set(["GOOGLE-CONV-001"]);

// A NEW critical money leak worth interrupting someone's day for.
const IMMEDIATE_MIN_RECOVERABLE = 1000;

/**
 * Is this finding urgent enough to interrupt with an immediate email?
 * Urgency, not just severity: a CRITICAL structural/hygiene issue is important
 * but not an emergency. Only "the account is on fire right now" qualifies.
 */
export const isImmediate = (finding) => {
  const ev = finding?.evidence || {};
  if (ev.blocksDelivery === true) return true; // ad disapproved / delivery blocked
  if (ALWAYS_IMMEDIATE_RULES.has(finding?.ruleId)) return true; // tracking break
  if (ev.reason === "zero_conversions") return true; // live spend returning nothing
  if (
    finding?.severity === "CRITICAL" &&
    ev.diagnostic !== true &&
    parseImpactDollars(finding?.estimatedImpact) >= IMMEDIATE_MIN_RECOVERABLE
  ) {
    return true; // a large, newly-appeared critical leak
  }
  return false;
};

/**
 * Split a finding set into immediate-alert vs digest, scoped to what's NEW.
 *
 * @param {object} args
 * @param {Array}  args.findings        current audit's findings
 * @param {Array}  args.previousRuleIds ruleIds from the previous audit
 * @param {boolean} args.hasPrevious    false on a first audit → nothing immediate
 * @returns {{ immediate: Array, digest: Array, hasPrevious: boolean }}
 */
export const classifyAlerts = ({ findings = [], previousRuleIds = [], hasPrevious = false }) => {
  const prev = new Set(previousRuleIds);
  // First audit (no baseline): send nothing immediate — the report itself is the
  // first delivery and the user is actively looking at it. Monitoring value only
  // begins on the second audit, when the user isn't watching.
  const fresh = hasPrevious ? findings.filter((f) => f?.ruleId && !prev.has(f.ruleId)) : [];
  const immediate = fresh.filter(isImmediate);
  const digest = fresh.filter((f) => !isImmediate(f));
  return { immediate, digest, hasPrevious };
};

const toNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * A sharp CPA regression is a metric signal (not a single finding) worth an
 * immediate alert. Only fires on material spend with a real prior baseline.
 *
 * @returns {{ cpaNow, cpaPrev, pct } | null}
 */
export const detectCpaRegression = ({
  totals = {},
  prevTotals = {},
  thresholdPct = 30,
  materialSpend = 1000,
}) => {
  const cpaNow = toNumber(totals.conversions) > 0 ? toNumber(totals.spend) / toNumber(totals.conversions) : null;
  const cpaPrev = toNumber(prevTotals.conversions) > 0 ? toNumber(prevTotals.spend) / toNumber(prevTotals.conversions) : null;
  if (cpaNow == null || cpaPrev == null || cpaPrev <= 0) return null;
  if (toNumber(totals.spend) < materialSpend) return null;
  const pct = Math.round((cpaNow / cpaPrev - 1) * 100);
  if (pct < thresholdPct) return null;
  return { cpaNow, cpaPrev, pct };
};
