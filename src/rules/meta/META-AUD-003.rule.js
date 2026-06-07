import {
  getPlatformAnswers,
  getPlatformRecords,
} from "../shared/context-helpers.js";
import { matchesWord } from "../shared/text.js";

export default {
  id: "META-AUD-003",
  version: "1.0.0",
  platforms: ["META"],
  category: "Retargeting Coverage",
  severity: "HIGH",
  minPlanTier: "free",
  estimatedImpactRange: { min: 200, max: 8000 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["retargeting", "money-rule"],
  contextVersion: "v1",
  legacyRuleId: "AUD-003",

  eval(ctx) {
    const records = getPlatformRecords(ctx.dataset, "META");
    if (records.length === 0) return null;

    const answers = getPlatformAnswers(ctx.audit, "META");

    if (!matchesWord(answers.M5, ["no"])) return null;

    return {
      ruleId: "AUD-003",
      platform: "META",
      severity: "HIGH",
      category: "Retargeting Coverage",
      title: "No Meta retargeting campaign was reported",
      detail:
        "Warm audiences often convert more efficiently than cold traffic.",
      evidence: { M5: answers.M5 },
      estimatedImpact: "Missed low-funnel conversion opportunity.",
      fixSteps: [
        "Create retargeting audiences for site visitors and engaged users.",
        "Split short and longer recency windows where volume allows.",
      ],
    };
  },
};
