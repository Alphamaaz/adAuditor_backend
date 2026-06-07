import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { generateAuditPdfFile } from "./pdfReport.service.js";

const TMP = path.join(process.cwd(), "storage", "test-pdf");

const auditWithV2Output = () => ({
  id: "pdf_test_1",
  adAccount: { name: "Test Account" },
  healthScore: 62,
  uploadReadiness: { mode: "FULL" },
  ruleFindings: [
    { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", category: "Audience Strategy", title: "Seg waste", estimatedImpact: "$206" },
  ],
  aiReport: {
    output: {
      executiveSummary: ["Para one.", "Para two."],
      confidenceNotes: ["High confidence."],
      topPriorities: [
        { ruleId: "SEG-WASTE-001", platform: "META", severity: "MEDIUM", title: "Segment waste", estimatedImpact: "$206", recommendedAction: "Exclude segment" },
      ],
      quickWins: [{ ruleId: "SEG-WASTE-001", platform: "META", title: "Trim segment", fixSteps: ["exclude 45-54"] }],
      clientReadyRecommendations: [
        { headline: "Cut the 45-54 segment", explanation: "It wasted $206 with zero conversions.", nextSteps: ["exclude it"], sourceRuleIds: ["SEG-WASTE-001"] },
      ],
      // v2 fields
      auditNarrativeVersion: "v2-evidence-packet",
      dataConfidenceSummary: "No tracking issues detected.",
      segmentInsights: ["The 45-54 age segment wasted $206 with zero conversions."],
      comparisonInsights: ["CTR is 75% below your Best Account."],
      memoryInsights: ["CPA worsened 100% since your last audit."],
      risksAndAssumptions: ["Sample is directional for the 65+ segment."],
    },
  },
});

describe("PDF generation with v2 evidence-packet fields", () => {
  it("generates a PDF without throwing and writes a file", async () => {
    process.env.PDF_STORAGE_DIR = TMP;
    const result = await generateAuditPdfFile({ audit: auditWithV2Output(), version: 1 });
    expect(fs.existsSync(result.absolutePath)).toBe(true);
    expect(fs.statSync(result.absolutePath).size).toBeGreaterThan(0);
  });

  it("generates a PDF for an OLD report missing v2 fields (backward compat)", async () => {
    process.env.PDF_STORAGE_DIR = TMP;
    const audit = auditWithV2Output();
    delete audit.aiReport.output.segmentInsights;
    delete audit.aiReport.output.comparisonInsights;
    delete audit.aiReport.output.memoryInsights;
    delete audit.aiReport.output.risksAndAssumptions;
    audit.id = "pdf_test_legacy";
    const result = await generateAuditPdfFile({ audit, version: 1 });
    expect(fs.existsSync(result.absolutePath)).toBe(true);
  });
});

afterAll(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});
