import {
  getPlatformAnswers,
  getPlatformRecords,
} from "../shared/context-helpers.js";
import { matchesWord, text } from "../shared/text.js";

export default {
  id: "META-AUD-001",
  version: "1.0.0",
  platforms: ["META"],
  category: "Audience Strategy",
  severity: "HIGH",
  minPlanTier: "free",
  estimatedImpactRange: { min: 200, max: 5000 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["audience", "money-rule"],
  contextVersion: "v1",
  legacyRuleId: "AUD-001",

  eval(ctx) {
    // Preserve legacy ordering: this rule only fires when Meta data exists.
    const records = getPlatformRecords(ctx.dataset, "META");
    if (records.length === 0) return null;

    const answers = getPlatformAnswers(ctx.audit, "META");

    if (!(matchesWord(answers.M6, ["no"]) || text(answers.M6).includes("unsure"))) {
      return null;
    }

    return {
      ruleId: "AUD-001",
      platform: "META",
      severity: "HIGH",
      category: "Audience Strategy",
      title: "Existing customer exclusion is not confirmed",
      detail:
        "Prospecting campaigns can waste spend if existing customers are not excluded.",
      evidence: { M6: answers.M6 },
      estimatedImpact:
        "Can inflate CPA by spending prospecting budget on existing buyers.",
      fixSteps: [
        "Create a customer list audience.",
        "Exclude it from prospecting ad sets.",
        "Keep the list refreshed from CRM or ecommerce purchases.",
      ],
    };
  },
};
