import {
  getPlatformAnswers,
  getPlatformRecords,
} from "../shared/context-helpers.js";
import { includesAny } from "../shared/text.js";

export default {
  id: "META-CRE-001",
  version: "1.0.0",
  platforms: ["META"],
  category: "Creative Performance",
  severity: "HIGH",
  minPlanTier: "free",
  estimatedImpactRange: { min: 300, max: 10000 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["creative", "money-rule"],
  contextVersion: "v1",
  legacyRuleId: "CRE-001",

  eval(ctx) {
    const records = getPlatformRecords(ctx.dataset, "META");
    if (records.length === 0) return null;

    const answers = getPlatformAnswers(ctx.audit, "META");

    if (!includesAny(answers.M8, ["monthly", "rarely"])) return null;

    return {
      ruleId: "CRE-001",
      platform: "META",
      severity: "HIGH",
      category: "Creative Performance",
      title: "Creative refresh cadence is slow",
      detail:
        "Stale creative usually causes fatigue and weaker engagement over time.",
      evidence: { M8: answers.M8 },
      estimatedImpact: "Can increase CPM and CPA as audiences tire of ads.",
      fixSteps: [
        "Create a recurring creative testing cadence.",
        "Refresh hooks, offers, formats, and angles at least bi-weekly where spend allows.",
      ],
    };
  },
};
