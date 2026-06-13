import { describe, expect, it } from "vitest";
import { buildReportDocumentFromAudit, validateReportDocument } from "./reportDocument.service.js";
import { renderAuditPremiumReportHtml, renderBlock, renderReport } from "./premiumReportRenderer.service.js";

const baseAudit = (overrides = {}) => ({
  id: "audit-premium-1",
  selectedPlatforms: ["GOOGLE"],
  healthScore: 68,
  categoryScores: {
    biddingStrategyAlignment: 60,
    campaignStructure: 82,
    conversionTracking: 100,
  },
  completedAt: "2026-05-31T00:00:00.000Z",
  normalizedDataset: {
    summary: {
      totals: {
        spend: 49594,
        conversions: 73,
        currency: "USD",
      },
    },
  },
  ruleFindings: [
    {
      ruleId: "SEG-WASTE-001",
      platform: "GOOGLE",
      severity: "MEDIUM",
      category: "Bidding",
      title: "Tuesdays are quietly burning budget",
      detail: "Tuesday delivery is above the account baseline CPA.",
      estimatedImpact: "$3,562",
      evidence: {
        segment: "Tuesday",
        segmentCost: 194,
        baselineCpa: 145,
        confidence: "high",
      },
      fixSteps: ["Down-bid Tuesday delivery.", "Move budget to efficient days."],
    },
    {
      ruleId: "KW-010",
      platform: "GOOGLE",
      severity: "MEDIUM",
      category: "Keywords",
      title: "Many active keywords get zero impressions",
      detail: "The keyword set adds clutter without entering auctions.",
      estimatedImpact: null,
      evidence: { zeroImpressionKeywords: 1188, confidence: "medium" },
      fixSteps: ["Pause zero-impression terms."],
    },
  ],
  ...overrides,
});

describe("premium report renderer", () => {
  it("builds a valid ReportDocument from any audit shape", () => {
    const doc = buildReportDocumentFromAudit(baseAudit());
    const validation = validateReportDocument(doc);
    expect(validation.isValid).toBe(true);
    expect(doc.key_numbers).toHaveLength(4);
    expect(doc.sections.some((section) => section.id === "finding-detail")).toBe(true);
  });

  it("renders deterministic HTML for identical input", () => {
    const audit = baseAudit();
    const first = renderAuditPremiumReportHtml(audit);
    const second = renderAuditPremiumReportHtml(audit);
    expect(first).toBe(second);
    expect(first).toContain("Tuesdays are quietly burning budget");
    expect(first).toContain("Tuesday CPA");
  });

  it("does not render empty benchmark sections", () => {
    const html = renderAuditPremiumReportHtml(baseAudit());
    expect(html).not.toContain('id="benchmarks"');
  });

  it("renders a clean near-perfect account with no findings", () => {
    const doc = buildReportDocumentFromAudit(
      baseAudit({ healthScore: 96, ruleFindings: [], categoryScores: { conversionTracking: 100 } })
    );
    const html = renderReport(doc);
    expect(doc.sections).toHaveLength(0);
    expect(html).toContain("No measurable money leaks detected");
    expect(html).not.toContain("Not quantified");
  });

  it("sanitizes evidence table cells for client-readable output", () => {
    const html = renderBlock({
      type: "evidence_table",
      currency: "PKR",
      proseContext: "PKR 3,465 is already explained in the paragraph.",
      rows: [
        {
          metric: "estimatedImpact",
          value:
            "PKR 3,465 in this segment is recoverable by reducing or excluding it. Reallocate budget.",
        },
        { metric: "reason", value: "worse_than_baseline" },
        { metric: "segment", value: "TUESDAY" },
        { metric: "segmentCost", value: 13866 },
        { metric: "currency", value: "PKR" },
      ],
    });

    expect(html).not.toContain("Reallocate budget");
    expect(html).not.toContain("worse_than_baseline");
    expect(html).not.toContain(">Currency<");
    expect(html).toContain("Worse than baseline");
    expect(html).toContain("Tuesday");
    expect(html).toContain("PKR 13,866");
  });

  it("uses a score gauge instead of a one-bar chart when only overall score exists", () => {
    const doc = buildReportDocumentFromAudit(
      baseAudit({ healthScore: 76, categoryScores: { overall: 76 } })
    );
    const scoreSection = doc.sections.find((section) => section.id === "scores");

    expect(scoreSection?.blocks[0].type).toBe("score_gauge");
    expect(renderReport(doc)).toContain("Component-level breakdown not available");
  });

  it("keeps client-facing findings readable and hides internal rule IDs", () => {
    const html = renderAuditPremiumReportHtml(baseAudit());

    expect(html).toContain("Tuesdays are quietly burning budget");
    expect(html).not.toContain("Tuesdays are quietly burning...");
    expect(html).not.toContain("SEG-WASTE-001");
    expect(html).not.toContain("KW-010");
    expect(html).not.toContain("Not quantified");
    expect(html).not.toContain("rule engine");
  });

  it("sanitizes legacy table cells with raw html, rule codes, and unquantified impact", () => {
    const html = renderBlock({
      type: "data_table",
      currency: "PKR",
      columns: [
        { header: "#", align: "left" },
        { header: "Finding", align: "left" },
        { header: "Severity", align: "left" },
        { header: "Impact", align: "right" },
      ],
      rows: [
        [
          "1",
          'Meta CPM is critically above the B2B SaaS industry benchmark<br><span class="small">Bench CPM 001</span>',
          "High",
          "$2,245 recoverable",
        ],
        [
          "2",
          'Paused Meta ad sets still have budgets assigned<br><span class="small">Str 002</span>',
          "Medium",
          "Not quantified",
        ],
      ],
    });

    expect(html).toContain("Meta CPM is critically above the B2B SaaS industry benchmark");
    expect(html).toContain("Paused Meta ad sets still have budgets assigned");
    expect(html).toContain("PKR 2,245 recoverable");
    expect(html).toContain("Business risk");
    expect(html).not.toContain("<br>");
    expect(html).not.toContain("span");
    expect(html).not.toContain("Bench CPM 001");
    expect(html).not.toContain("Str 002");
    expect(html).not.toContain("Not quantified");
  });

  it("drops incomplete benchmark callouts instead of rendering undefined", () => {
    const doc = buildReportDocumentFromAudit(
      baseAudit({
        aiReport: {
          output: {
            benchmarkComparisons: [
              { label: undefined, finding: undefined },
              { label: "Peer comparison", finding: "CTR is below the peer account.", confidence: "medium" },
            ],
          },
        },
      })
    );
    const html = renderReport(doc);

    expect(html).toContain("Peer comparison");
    expect(html).not.toContain("undefined");
  });
});
