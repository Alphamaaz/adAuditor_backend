import {
  getPlatformAnswers,
  getPlatformRecords,
} from "../shared/context-helpers.js";
import { numberValue } from "../shared/numeric.js";

export default {
  id: "META-STR-006",
  version: "1.0.0",
  platforms: ["META"],
  category: "Campaign Structure",
  severity: "MEDIUM",
  minPlanTier: "free",
  estimatedImpactRange: { min: 100, max: 2500 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["structure"],
  contextVersion: "v1",
  legacyRuleId: "STR-006",

  eval(ctx) {
    const records = getPlatformRecords(ctx.dataset, "META");
    if (records.length === 0) return null;

    const answers = getPlatformAnswers(ctx.audit, "META");
    const averageAds = numberValue(answers.M7);

    if (!(averageAds > 0 && (averageAds < 3 || averageAds > 8))) return null;

    return {
      ruleId: "STR-006",
      platform: "META",
      severity: "MEDIUM",
      category: "Campaign Structure",
      title: "Ad volume per ad set is outside the recommended range",
      detail:
        "Too few ads limits testing; too many ads can fragment delivery.",
      evidence: { averageAdsPerAdSet: averageAds },
      estimatedImpact:
        "Can slow creative learning and make winners harder to identify.",
      fixSteps: ["Keep roughly 3-8 active ads per ad set during testing."],
    };
  },
};
