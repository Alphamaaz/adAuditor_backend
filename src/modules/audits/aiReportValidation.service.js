const isString = (value) => typeof value === "string" && value.trim().length > 0;

const validateRuleReference = (ruleId, allowedRuleIds, path, errors) => {
  if (!isString(ruleId)) {
    errors.push(`${path} must be a non-empty rule ID.`);
    return;
  }

  if (!allowedRuleIds.has(ruleId)) {
    errors.push(`${path} references unknown rule ID ${ruleId}.`);
  }
};

export const validateAiReportOutput = ({ output, findings }) => {
  const errors = [];
  const allowedRuleIds = new Set(findings.map((finding) => finding.ruleId));

  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return {
      isValid: false,
      errors: ["AI output must be an object."],
    };
  }

  if (!Array.isArray(output.executiveSummary) || output.executiveSummary.length < 2) {
    errors.push("executiveSummary must contain at least 2 paragraphs.");
  }

  if (!Array.isArray(output.topPriorities)) {
    errors.push("topPriorities must be an array.");
  } else {
    output.topPriorities.forEach((priority, index) => {
      validateRuleReference(
        priority?.ruleId,
        allowedRuleIds,
        `topPriorities[${index}].ruleId`,
        errors
      );
    });
  }

  if (!Array.isArray(output.quickWins)) {
    errors.push("quickWins must be an array.");
  } else {
    output.quickWins.forEach((quickWin, index) => {
      validateRuleReference(
        quickWin?.ruleId,
        allowedRuleIds,
        `quickWins[${index}].ruleId`,
        errors
      );
    });
  }

  if (!Array.isArray(output.clientReadyRecommendations)) {
    errors.push("clientReadyRecommendations must be an array.");
  } else {
    output.clientReadyRecommendations.forEach((recommendation, index) => {
      if (!Array.isArray(recommendation?.sourceRuleIds)) {
        errors.push(
          `clientReadyRecommendations[${index}].sourceRuleIds must be an array.`
        );
        return;
      }

      recommendation.sourceRuleIds.forEach((ruleId, ruleIndex) => {
        validateRuleReference(
          ruleId,
          allowedRuleIds,
          `clientReadyRecommendations[${index}].sourceRuleIds[${ruleIndex}]`,
          errors
        );
      });
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
};

// ── Factuality check ────────────────────────────────────────────────────────
// Scans the AI output for dollar amounts that do NOT appear in the verified
// evidence (packet verifiedNumbers + finding evidence). Lightweight + tolerant:
// it returns warnings, never hard-fails the report, so retries/fallback stay
// intact. Percentages and multipliers ("3×") are intentionally NOT checked —
// the prompt legitimately asks the model to express goal ratios.

const DOLLAR_RX = /\$\s?([\d,]+(?:\.\d+)?)/g;

const collectStrings = (value, sink) => {
  if (value == null) return;
  if (typeof value === "string") {
    sink.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectStrings(v, sink));
  } else if (typeof value === "object") {
    Object.values(value).forEach((v) => collectStrings(v, sink));
  }
};

/**
 * @param {object} args
 * @param {object} args.output         AI report output object
 * @param {number[]} args.verifiedNumbers  Dollar magnitudes from the evidence packet
 * @param {number} [args.tolerance]    Allowed rounding drift (default 1)
 * @returns {{ ok: boolean, warnings: string[], fabricatedNumbers: number[] }}
 */
export const validateAiReportFactuality = ({
  output,
  verifiedNumbers = [],
  tolerance = 1,
}) => {
  const verified = new Set(verifiedNumbers.map((n) => Math.round(n)));
  const strings = [];
  collectStrings(output, strings);

  const fabricated = new Set();
  for (const str of strings) {
    let m;
    DOLLAR_RX.lastIndex = 0;
    while ((m = DOLLAR_RX.exec(str)) !== null) {
      const n = Math.round(Number(m[1].replace(/,/g, "")));
      if (!Number.isFinite(n) || n === 0) continue;
      // Allow exact match or within rounding tolerance of any verified number.
      const known = [...verified].some((v) => Math.abs(v - n) <= tolerance);
      if (!known) fabricated.add(n);
    }
  }

  const fabricatedNumbers = [...fabricated];
  const warnings = fabricatedNumbers.map(
    (n) =>
      `AI output references $${n.toLocaleString()} which is not present in verified evidence.`
  );

  return {
    ok: fabricatedNumbers.length === 0,
    warnings,
    fabricatedNumbers,
  };
};

// Phrases that signal a low-value, generic recommendation the model fell back
// to instead of citing the account's specifics.
const GENERIC_PHRASES = [
  "review your campaigns",
  "optimize your ads",
  "improve performance",
  "monitor performance",
  "consider optimizing",
  "make sure to",
  "best practices",
  "keep an eye on",
];

/**
 * Flags client-ready recommendations that are too short or use generic
 * boilerplate instead of account-specific facts. Warnings only — never blocks
 * a report (we don't want to strand the user), but surfaces quality issues
 * for monitoring + prompt tuning.
 *
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export const validateRecommendationsNotGeneric = ({ output }) => {
  const warnings = [];
  const recs = Array.isArray(output?.clientReadyRecommendations)
    ? output.clientReadyRecommendations
    : [];

  recs.forEach((rec, index) => {
    const explanation = typeof rec?.explanation === "string" ? rec.explanation : "";
    const headline = typeof rec?.headline === "string" ? rec.headline : "";

    if (explanation.trim().length < 40) {
      warnings.push(
        `clientReadyRecommendations[${index}] explanation is too short to be actionable.`
      );
    }
    const lower = `${headline} ${explanation}`.toLowerCase();
    const hit = GENERIC_PHRASES.find((p) => lower.includes(p));
    // Generic phrasing is only a problem when there are no numbers to anchor it.
    const hasNumber = /\d/.test(explanation);
    if (hit && !hasNumber) {
      warnings.push(
        `clientReadyRecommendations[${index}] reads generic ("${hit}") with no specific numbers.`
      );
    }
  });

  return { ok: warnings.length === 0, warnings };
};
