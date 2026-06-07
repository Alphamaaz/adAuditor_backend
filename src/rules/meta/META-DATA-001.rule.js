import { getPlatformRecords } from "../shared/context-helpers.js";

export default {
  id: "META-DATA-001",
  version: "1.0.0",
  platforms: ["META"],
  category: "Attribution & Reporting",
  severity: "CRITICAL",
  minPlanTier: "free",
  estimatedImpactRange: { min: 0, max: 0 },
  confidence: "high",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["data-quality", "blocking"],
  contextVersion: "v1",
  legacyRuleId: "DATA-001",

  eval(ctx) {
    const records = getPlatformRecords(ctx.dataset, "META");
    if (records.length !== 0) return null;

    return {
      ruleId: "DATA-001",
      platform: "META",
      severity: "CRITICAL",
      category: "Attribution & Reporting",
      title: "No validated Meta data was uploaded",
      detail:
        "The audit cannot evaluate Meta performance without validated Meta exports.",
      evidence: { uploadedRows: 0 },
      estimatedImpact: "Meta score is limited until account data is uploaded.",
      fixSteps: [
        "Upload a valid Meta ad, ad set, campaign, or pixel export.",
      ],
    };
  },
};
