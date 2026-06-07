/**
 * Narrative eval rubric.
 *
 * Scores an AI audit report against a golden fixture + the deterministic
 * evidence packet. Pure + deterministic — no AI call required to SCORE
 * (the report being scored may be a fixture reference output or a live
 * provider response).
 *
 * Dimensions (each 0..1):
 *   factuality         — no invented dollar figures (vs verifiedNumbers)
 *   ruleIdCorrectness  — structural validity + all referenced ruleIds exist
 *   dollarCorrectness  — required dollar magnitudes are surfaced
 *   specificity        — priorities cite concrete numbers
 *   actionability      — priorities/recs carry concrete actions
 *   genericFree        — recommendations are not boilerplate
 *   sourceRuleIds      — recommendation sources all exist
 *   themeCoverage      — expected themes (tracking/waste/segment/peer/memory) present
 *   requiredRules      — fixture's required ruleIds are referenced
 *   forbiddenAbsent    — fixture's forbidden invented numbers are absent
 *
 * Hard gates (must be true to PASS regardless of weighted total):
 *   factuality === 1, ruleIdCorrectness === 1, sourceRuleIds === 1,
 *   forbiddenAbsent === 1
 */

import {
  validateAiReportOutput,
  validateAiReportFactuality,
  validateRecommendationsNotGeneric,
} from "../../modules/audits/aiReportValidation.service.js";

const WEIGHTS = {
  factuality: 0.18,
  ruleIdCorrectness: 0.16,
  dollarCorrectness: 0.12,
  specificity: 0.12,
  actionability: 0.12,
  genericFree: 0.1,
  sourceRuleIds: 0.08,
  themeCoverage: 0.06,
  requiredRules: 0.04,
  forbiddenAbsent: 0.02,
};

const PASS_THRESHOLD = 0.8;

const THEME_KEYWORDS = {
  tracking: ["tracking", "pixel", "capi", "attribution", "conversion event"],
  waste: ["waste", "wasted", "zero conversion", "zero-conversion", "zero result"],
  segment: ["segment", "age", "placement", "device", "demographic"],
  peer: ["peer", "compared", "vs ", "below your", "another account", "portfolio"],
  memory: ["since your last", "prior audit", "improved", "worsened", "deteriorat"],
};

const startsWithVerb = (s) =>
  typeof s === "string" && /^[A-Z][a-z]+(\s|$)/.test(s.trim());

const outputText = (output) => JSON.stringify(output || {}).toLowerCase();

const referencedRuleIds = (output) => {
  const ids = new Set();
  (output?.topPriorities || []).forEach((p) => p?.ruleId && ids.add(p.ruleId));
  (output?.quickWins || []).forEach((q) => q?.ruleId && ids.add(q.ruleId));
  (output?.clientReadyRecommendations || []).forEach((r) =>
    (r?.sourceRuleIds || []).forEach((id) => ids.add(id))
  );
  return ids;
};

export const scoreReport = ({ output, packet, findings = [], expected = {} }) => {
  const failures = [];
  const verifiedNumbers = packet?.verifiedNumbers || [];

  // ── factuality ──
  const fact = validateAiReportFactuality({ output, verifiedNumbers });
  const factuality = fact.ok ? 1 : 0;
  if (!fact.ok) failures.push(`factuality: ${fact.warnings.join("; ")}`);

  // ── ruleId correctness (structural + references valid) ──
  const structural = validateAiReportOutput({ output, findings });
  const ruleIdCorrectness = structural.isValid ? 1 : 0;
  if (!structural.isValid) failures.push(`structure: ${structural.errors.join("; ")}`);

  // ── dollar correctness: required magnitudes surfaced ──
  const reqDollars = expected.requiredDollars || [];
  const text = outputText(output);
  const dollarsHit = reqDollars.filter((n) =>
    text.includes(String(n)) || text.includes(Number(n).toLocaleString())
  );
  const dollarCorrectness = reqDollars.length
    ? dollarsHit.length / reqDollars.length
    : 1;
  if (dollarCorrectness < 1) {
    failures.push(
      `dollarCorrectness: missing ${reqDollars
        .filter((n) => !dollarsHit.includes(n))
        .join(", ")}`
    );
  }

  // ── specificity: priorities cite concrete numbers ──
  const priorities = output?.topPriorities || [];
  const specHits = priorities.filter((p) => /\d/.test(p?.estimatedImpact || ""));
  const specificity = priorities.length ? specHits.length / priorities.length : 0;

  // ── actionability: priorities have a verb action; recs have nextSteps ──
  const actionPriorities = priorities.filter((p) =>
    startsWithVerb(p?.recommendedAction)
  );
  const recs = output?.clientReadyRecommendations || [];
  const actionRecs = recs.filter((r) => (r?.nextSteps || []).length > 0);
  const actionParts = [];
  if (priorities.length) actionParts.push(actionPriorities.length / priorities.length);
  if (recs.length) actionParts.push(actionRecs.length / recs.length);
  const actionability = actionParts.length
    ? actionParts.reduce((a, b) => a + b, 0) / actionParts.length
    : 0;

  // ── generic-free ──
  const generic = validateRecommendationsNotGeneric({ output });
  const genericFree = generic.ok ? 1 : 0;
  if (!generic.ok) failures.push(`generic: ${generic.warnings.join("; ")}`);

  // ── sourceRuleIds all exist (hard gate) ──
  const known = new Set(findings.map((f) => f.ruleId));
  const allSourceIds = recs.flatMap((r) => r?.sourceRuleIds || []);
  const sourceRuleIds =
    allSourceIds.length === 0
      ? 1
      : allSourceIds.every((id) => known.has(id))
        ? 1
        : 0;
  if (sourceRuleIds < 1) failures.push("sourceRuleIds: unknown source rule referenced");

  // ── theme coverage ──
  const themes = expected.themes || [];
  const themesHit = themes.filter((t) =>
    (THEME_KEYWORDS[t] || [t]).some((kw) => text.includes(kw))
  );
  const themeCoverage = themes.length ? themesHit.length / themes.length : 1;
  if (themeCoverage < 1) {
    failures.push(
      `themeCoverage: missing ${themes.filter((t) => !themesHit.includes(t)).join(", ")}`
    );
  }

  // ── required ruleIds referenced ──
  const refIds = referencedRuleIds(output);
  const reqRules = expected.requiredRuleIds || [];
  const reqHit = reqRules.filter((id) => refIds.has(id));
  const requiredRules = reqRules.length ? reqHit.length / reqRules.length : 1;
  if (requiredRules < 1) {
    failures.push(
      `requiredRules: missing ${reqRules.filter((id) => !reqIds(refIds, id)).join(", ")}`
    );
  }

  // ── forbidden invented numbers absent (hard gate) ──
  const forbidden = expected.forbiddenNumbers || [];
  const forbiddenPresent = forbidden.filter(
    (n) => text.includes(String(n)) || text.includes(Number(n).toLocaleString())
  );
  const forbiddenAbsent = forbiddenPresent.length === 0 ? 1 : 0;
  if (!forbiddenAbsent) {
    failures.push(`forbiddenAbsent: invented ${forbiddenPresent.join(", ")}`);
  }

  const scores = {
    factuality,
    ruleIdCorrectness,
    dollarCorrectness: Number(dollarCorrectness.toFixed(3)),
    specificity: Number(specificity.toFixed(3)),
    actionability: Number(actionability.toFixed(3)),
    genericFree,
    sourceRuleIds,
    themeCoverage: Number(themeCoverage.toFixed(3)),
    requiredRules: Number(requiredRules.toFixed(3)),
    forbiddenAbsent,
  };

  const total = Object.entries(WEIGHTS).reduce(
    (sum, [k, w]) => sum + (scores[k] ?? 0) * w,
    0
  );

  const hardGatesPass =
    factuality === 1 &&
    ruleIdCorrectness === 1 &&
    sourceRuleIds === 1 &&
    forbiddenAbsent === 1;

  return {
    scores,
    total: Number(total.toFixed(3)),
    pass: hardGatesPass && total >= PASS_THRESHOLD,
    hardGatesPass,
    threshold: PASS_THRESHOLD,
    failures,
  };
};

// tiny helper used above (kept local to avoid an extra import)
function reqIds(set, id) {
  return set.has(id);
}

export const __test__ = { WEIGHTS, PASS_THRESHOLD, THEME_KEYWORDS };
