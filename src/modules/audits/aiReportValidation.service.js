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
