import { describe, it, expect } from "vitest";
import { __test__ } from "./aiProvider.service.js";
import { buildAiAuditContext } from "./aiContext.service.js";

const { buildSystemPrompt, buildUserPrompt } = __test__;

const auditFixture = () => ({
  id: "aud_1",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "MANUAL_UPLOAD",
  healthScore: 62,
  categoryScores: {},
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce", targetCpa: 50, monthlyBudget: 5000 } },
  uploadReadiness: { mode: "FULL" },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  normalizedDataset: {
    summary: { totals: { spend: 5000, conversions: 100 }, platforms: { GOOGLE: { spend: 5000 } } },
  },
  ruleFindings: [
    {
      ruleId: "GOOGLE-SEARCH-TERM-WASTE-001",
      platform: "GOOGLE",
      severity: "HIGH",
      category: "Keyword Strategy",
      title: "$1,200 wasted",
      evidence: { wastedSpend: 1200 },
      estimatedImpact: "$1,200 in identified waste.",
      fixSteps: ["add negatives"],
    },
  ],
  aiReport: null,
});

describe("evidence-packet-first prompt", () => {
  it("system prompt declares the evidence packet as source of truth + bans arithmetic", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("EVIDENCE PACKET IS THE SOURCE OF TRUTH");
    expect(sys.toLowerCase()).toContain("never to calculate");
    expect(sys).toContain("PRIORITY ORDER");
  });

  it("user prompt embeds the evidencePacket and the new output fields", () => {
    const context = buildAiAuditContext(auditFixture(), { priorAudits: [] });
    const prompt = buildUserPrompt(context);
    expect(prompt).toContain("EVIDENCE PACKET");
    expect(prompt).toContain("segmentInsights");
    expect(prompt).toContain("comparisonInsights");
    expect(prompt).toContain("memoryInsights");
    // The verified number from the finding must be present in the embedded packet.
    expect(prompt).toContain("1200");
  });

  it("does not embed raw rows (only summary/findings)", () => {
    const context = buildAiAuditContext(auditFixture(), { priorAudits: [] });
    const prompt = buildUserPrompt(context);
    expect(context.contextLimits.rawRowsIncluded).toBe(false);
    // No raw record arrays leaked.
    expect(prompt).not.toContain('"byLevel"');
  });

  it("treats a verified Analyst result as authoritative and Deep Audit as supplementary", () => {
    const context = buildAiAuditContext(auditFixture(), { priorAudits: [] });
    context.verifiedAnalyst = {
      report: {
        executiveSummary: "Verified account story without unsupported numbers.",
        rootCause: "The verified root cause is conversion measurement quality.",
        findings: [
          {
            id: "AN-MEASUREMENT",
            title: "Measurement needs repair",
            claim: "Conversion reporting is inconsistent.",
            confidence: "high",
            recommendation: "Repair the primary conversion action.",
            figures: [],
          },
        ],
        recommendations: [],
      },
    };
    context.deepAudit = {
      mode: "deep",
      report: {
        headline: "Supplementary hypothesis",
        rootCause: "An older aggregate-only diagnosis.",
        confidence: "medium",
        recommendations: [],
      },
      reasoningTrace: [],
    };

    const prompt = buildUserPrompt(context);
    expect(prompt).toContain("VERIFIED FULL-DATA ANALYST RESULT (authoritative when present)");
    expect(prompt).toContain("Verified account story without unsupported numbers.");
    expect(prompt).toContain("supplementary; never override verified Analyst facts");
  });
});
