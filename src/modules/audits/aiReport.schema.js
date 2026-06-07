export const aiReportJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "executiveSummary",
    "topPriorities",
    "quickWins",
    "confidenceNotes",
    "clientReadyRecommendations",
    "auditNarrativeVersion",
    "dataConfidenceSummary",
    "segmentInsights",
    "comparisonInsights",
    "memoryInsights",
    "risksAndAssumptions",
  ],
  properties: {
    executiveSummary: {
      type: "array",
      minItems: 2,
      maxItems: 3,
      items: {
        type: "string",
      },
    },
    topPriorities: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ruleId",
          "platform",
          "severity",
          "title",
          "estimatedImpact",
          "recommendedAction",
        ],
        properties: {
          ruleId: { type: "string" },
          platform: {
            anyOf: [
              { type: "string", enum: ["META", "GOOGLE", "TIKTOK"] },
              { type: "null" },
            ],
          },
          severity: {
            type: "string",
            enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
          },
          title: { type: "string" },
          estimatedImpact: { type: "string" },
          recommendedAction: { type: "string" },
        },
      },
    },
    quickWins: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ruleId", "platform", "title", "fixSteps"],
        properties: {
          ruleId: { type: "string" },
          platform: {
            anyOf: [
              { type: "string", enum: ["META", "GOOGLE", "TIKTOK"] },
              { type: "null" },
            ],
          },
          title: { type: "string" },
          fixSteps: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
        },
      },
    },
    confidenceNotes: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "string",
      },
    },
    clientReadyRecommendations: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "explanation", "nextSteps", "sourceRuleIds"],
        properties: {
          headline: { type: "string" },
          explanation: { type: "string" },
          nextSteps: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
          sourceRuleIds: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string" },
          },
        },
      },
    },
    // ── v2 evidence-packet fields (additive; OpenAI-strict-safe: required +
    //    nullable/empty-array tolerant). Older reports without them still load. ──
    auditNarrativeVersion: { type: "string" },
    dataConfidenceSummary: { type: ["string", "null"] },
    segmentInsights: { type: "array", maxItems: 5, items: { type: "string" } },
    comparisonInsights: { type: "array", maxItems: 3, items: { type: "string" } },
    memoryInsights: { type: "array", maxItems: 3, items: { type: "string" } },
    risksAndAssumptions: { type: "array", maxItems: 4, items: { type: "string" } },
  },
};
