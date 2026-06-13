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
    "opportunitySummary",
    "findingAnalyses",
    "hypothesisAnalyses",
    "benchmarkComparisons",
  ],
  properties: {
    premiumReport: {
      type: "object",
      additionalProperties: true,
    },
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
    opportunitySummary: {
      type: "object",
      additionalProperties: false,
      required: [
        "biggestMoneyLeak",
        "estimatedWaste",
        "estimatedUpside",
        "auditFocus",
        "rankingBasis",
      ],
      properties: {
        biggestMoneyLeak: { type: ["string", "null"] },
        estimatedWaste: { type: ["string", "null"] },
        estimatedUpside: { type: ["string", "null"] },
        auditFocus: { type: ["string", "null"] },
        rankingBasis: { type: "string" },
      },
    },
    findingAnalyses: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "ruleId",
          "platform",
          "title",
          "whatIsHappening",
          "whyItIsHappening",
          "evidence",
          "estimatedBusinessImpact",
          "confidence",
          "easeOfImplementation",
          "recommendedActions",
          "expectedOutcome",
        ],
        properties: {
          ruleId: { type: "string" },
          platform: {
            anyOf: [
              { type: "string", enum: ["META", "GOOGLE", "TIKTOK"] },
              { type: "null" },
            ],
          },
          title: { type: "string" },
          whatIsHappening: { type: "string" },
          whyItIsHappening: { type: "string" },
          evidence: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
          estimatedBusinessImpact: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          easeOfImplementation: { type: "string", enum: ["easy", "medium", "hard"] },
          recommendedActions: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
          expectedOutcome: { type: "string" },
        },
      },
    },
    hypothesisAnalyses: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hypothesis", "testsRun", "conclusion", "confidence", "sourceRuleIds"],
        properties: {
          hypothesis: { type: "string" },
          testsRun: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
          conclusion: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          sourceRuleIds: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
        },
      },
    },
    benchmarkComparisons: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "comparisonType", "finding", "confidence"],
        properties: {
          label: { type: "string" },
          comparisonType: { type: "string", enum: ["industry", "historical", "peer"] },
          finding: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};
