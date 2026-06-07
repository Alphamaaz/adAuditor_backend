import { describe, it, expect } from "vitest";
import {
  validateAiReportOutput,
  validateRecommendationsNotGeneric,
} from "./aiReportValidation.service.js";

const findings = [
  { ruleId: "GOOGLE-SEARCH-TERM-WASTE-001" },
  { ruleId: "DIAG-CPA-001" },
];

const validOutput = () => ({
  executiveSummary: ["Para one with detail.", "Para two with detail."],
  topPriorities: [
    { ruleId: "GOOGLE-SEARCH-TERM-WASTE-001", platform: "GOOGLE", severity: "HIGH", title: "x", estimatedImpact: "$1,200", recommendedAction: "Add negatives" },
  ],
  quickWins: [],
  clientReadyRecommendations: [
    { headline: "Cut wasted search spend", explanation: "Add negatives to recover $1,200 of zero-conversion spend.", nextSteps: ["export terms"], sourceRuleIds: ["GOOGLE-SEARCH-TERM-WASTE-001"] },
  ],
});

describe("validateAiReportOutput — rule reference integrity", () => {
  it("accepts output that only references known ruleIds", () => {
    const r = validateAiReportOutput({ output: validOutput(), findings });
    expect(r.isValid).toBe(true);
  });

  it("rejects an invented ruleId in topPriorities", () => {
    const out = validOutput();
    out.topPriorities[0].ruleId = "MADE-UP-999";
    const r = validateAiReportOutput({ output: out, findings });
    expect(r.isValid).toBe(false);
    expect(r.errors.join(" ")).toContain("MADE-UP-999");
  });

  it("rejects an invented sourceRuleId in recommendations", () => {
    const out = validOutput();
    out.clientReadyRecommendations[0].sourceRuleIds = ["GHOST-001"];
    const r = validateAiReportOutput({ output: out, findings });
    expect(r.isValid).toBe(false);
    expect(r.errors.join(" ")).toContain("GHOST-001");
  });
});

describe("validateRecommendationsNotGeneric", () => {
  it("passes specific, number-anchored recommendations", () => {
    const r = validateRecommendationsNotGeneric({ output: validOutput() });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("warns on generic boilerplate with no numbers", () => {
    const out = validOutput();
    out.clientReadyRecommendations[0] = {
      headline: "Optimize your ads",
      explanation: "You should review your campaigns and improve performance using best practices.",
      nextSteps: ["do better"],
      sourceRuleIds: ["DIAG-CPA-001"],
    };
    const r = validateRecommendationsNotGeneric({ output: out });
    expect(r.ok).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it("warns on too-short explanations", () => {
    const out = validOutput();
    out.clientReadyRecommendations[0].explanation = "Fix it.";
    const r = validateRecommendationsNotGeneric({ output: out });
    expect(r.ok).toBe(false);
  });
});
