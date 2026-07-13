import { describe, it, expect, afterEach } from "vitest";
import {
  collectDatasetNumericPool,
  findUnsupportedProse,
} from "./analystProseVerification.js";
import { verifyAnalystReport } from "./analystVerification.service.js";
import { runAnalyst } from "./analystRun.service.js";

/**
 * Prose verification, phase 2 — deletion is the LAST resort, not the first:
 *  - numbers the dataset itself vouches for (cell values, derived ratios,
 *    totals, row counts) survive without a model-attached fact;
 *  - matching is precision-aware, so a true 100,000 total does NOT vouch for
 *    an invented 99,999;
 *  - proposed values in recommended actions are plans, kept and counted;
 *  - runAnalyst gives the model one repair turn to attach missing facts
 *    before verification deletes anything.
 */

const campaign = (name, spend, impressions, clicks, results, extra = {}) => ({
  name,
  status: "ACTIVE",
  spend,
  impressions,
  clicks,
  results,
  ...extra,
});

const auditFixture = ({ campaigns } = {}) => ({
  id: "audit-prose",
  selectedPlatforms: ["META"],
  healthScore: 55,
  businessProfileSnapshot: { sectionA: { businessType: "Ecommerce" } },
  intakeResponses: [],
  ruleFindings: [],
  normalizedDataset: {
    summary: {
      platforms: { META: { currency: "PKR", spend: 100000 } },
      totals: { spend: 100000, impressions: 500000, clicks: 10000, conversions: 500 },
    },
    data: {
      platforms: {
        META: {
          byLevel: {
            campaign: campaigns || [
              campaign("Alpha", 60000, 300000, 6000, 300, { budget: 100000 }),
              campaign("Beta", 40000, 200000, 4000, 200),
            ],
          },
          byDimension: {},
          byDay: [],
        },
      },
    },
  },
});

const baseReport = (overrides = {}) => ({
  executiveSummary:
    "The account concentrates its spend in Alpha while Beta runs without a usable conversion signal.",
  executiveFigures: [],
  rootCause: "Conversion tracking is only wired on half the account.",
  rootCauseFigures: [],
  findings: [
    {
      id: "AN-TRACKING-GAP",
      title: "Beta runs without usable conversion signal",
      severity: "HIGH",
      category: "tracking",
      campaignRefs: ["Beta"],
      claim: "Beta cannot attribute its reported conversions.",
      figures: [
        {
          label: "Beta spend",
          kind: "observation",
          value: 40000,
          compute: { op: "sum", platform: "META", table: "campaign", rows: ["Beta"], metric: "spend" },
        },
      ],
      recommendation: "Install the pixel purchase event on Beta's landing domain.",
      confidence: "high",
    },
  ],
  campaignDeepDives: [],
  ruleFindingDispositions: [],
  recommendations: [
    {
      priority: 1,
      action: "Fix tracking first.",
      expectedImpact: "Trustworthy CPA reads for every later decision.",
      figures: [],
    },
  ],
  ...overrides,
});

// ── Dataset pool rescues true numbers ────────────────────────────────────────

describe("dataset-backed prose survives without an attached fact", () => {
  it("keeps row-count claims ('all 4 campaigns')", () => {
    const audit = auditFixture({
      campaigns: [
        campaign("A", 100, 1000, 10, 1),
        campaign("B", 100, 1000, 10, 1),
        campaign("C", 100, 1000, 10, 1),
        campaign("D", 100, 1000, 10, 1),
      ],
    });
    const report = baseReport();
    report.findings[0].figures = [];
    report.findings[0].claim = "All 4 campaigns carry status PAUSED.";
    const { report: verified, droppedClaims } = verifyAnalystReport({ report, audit });
    expect(verified.findings[0].claim).toBe("All 4 campaigns carry status PAUSED.");
    expect(droppedClaims).toHaveLength(0);
  });

  it("keeps table cell values (a campaign's budget column)", () => {
    const report = baseReport();
    report.findings[0].claim = "Do not reactivate Alpha's 100000 PKR budget without verification.";
    const { report: verified, droppedClaims } = verifyAnalystReport({
      report,
      audit: auditFixture({}),
    });
    expect(verified.findings[0].claim).toContain("100000 PKR budget");
    expect(droppedClaims).toHaveLength(0);
  });

  it("keeps derived per-row ratios (a campaign's own CPA)", () => {
    const audit = auditFixture({
      campaigns: [campaign("Gamma", 47000, 200000, 4000, 12)], // CPA 3916.67
    });
    const report = baseReport();
    report.findings[0].figures = [];
    report.findings[0].claim = "Gamma converts at a proven PKR 3,917 CPA.";
    const { droppedClaims } = verifyAnalystReport({ report, audit });
    expect(droppedClaims).toHaveLength(0);
  });

  it("keeps summary totals in the executive summary", () => {
    const report = baseReport({
      executiveSummary:
        "The account spent PKR 100,000 across 500,000 impressions and 10,000 clicks for 500 conversions this period.",
    });
    const { report: verified, droppedClaims } = verifyAnalystReport({
      report,
      audit: auditFixture({}),
    });
    expect(verified.executiveSummary).toContain("PKR 100,000");
    expect(droppedClaims).toHaveLength(0);
  });

  it("keeps explicitly ROUND paraphrases of dataset values", () => {
    const audit = auditFixture({
      campaigns: [campaign("Alpha", 12427.65, 300000, 6000, 300)],
    });
    const report = baseReport();
    report.findings[0].figures = [];
    report.findings[0].claim = "Roughly PKR 12,400 of spend sits in Alpha.";
    const { droppedClaims } = verifyAnalystReport({ report, audit });
    expect(droppedClaims).toHaveLength(0);
  });

  it("does NOT let a true 100,000 total vouch for an invented 99,999", () => {
    const report = baseReport({
      executiveSummary:
        "The account wastes PKR 99,999 every month. Tracking quality needs immediate attention.",
    });
    const { report: verified, droppedClaims } = verifyAnalystReport({
      report,
      audit: auditFixture({}),
    });
    expect(verified.executiveSummary).toBe("Tracking quality needs immediate attention.");
    expect(droppedClaims).toHaveLength(1);
  });

  it("lets a verified figure ANYWHERE in the report back exec-summary prose", () => {
    const report = baseReport({
      executiveSummary:
        "Beta burned PKR 40,000 without a single attributable conversion this period.",
    });
    // 40000 is verified on the finding's figure — no executiveFigures needed.
    const { report: verified, droppedClaims } = verifyAnalystReport({
      report,
      audit: auditFixture({}),
    });
    expect(verified.executiveSummary).toContain("PKR 40,000");
    expect(droppedClaims).toHaveLength(0);
  });
});

// ── Prescriptive fields ──────────────────────────────────────────────────────

describe("prescriptive numbers are plans, not measurements", () => {
  it("keeps a proposed cap in a recommendation action and counts it", () => {
    const report = baseReport();
    report.recommendations[0].action =
      "Set a cost cap of PKR 175 and fund the ad set at PKR 1,500 per day.";
    const { report: verified, stats, droppedClaims } = verifyAnalystReport({
      report,
      audit: auditFixture({}),
    });
    expect(verified.recommendations[0].action).toContain("PKR 175");
    expect(droppedClaims).toHaveLength(0);
    expect(stats.prescriptiveUnsupportedClaims).toBe(2);
  });

  it("still drops unsupported OUTCOME claims in expectedImpact", () => {
    const report = baseReport();
    report.recommendations[0].expectedImpact = "Recovers PKR 7,777 in the next period.";
    const { report: verified, droppedClaims } = verifyAnalystReport({
      report,
      audit: auditFixture({}),
    });
    expect(verified.recommendations[0].expectedImpact).not.toContain("7,777");
    expect(droppedClaims.some((c) => c.path === "recommendations[0].expectedImpact")).toBe(true);
  });
});

// ── findUnsupportedProse (repair pre-flight) ─────────────────────────────────

describe("findUnsupportedProse", () => {
  const audit = auditFixture({});
  const pools = {
    datasetPool: collectDatasetNumericPool(audit),
    entityLabels: [],
  };

  it("flags novel numbers in strict fields", () => {
    const report = baseReport({
      executiveSummary: "The account wastes PKR 7,777 every single month on Beta.",
    });
    const flagged = findUnsupportedProse(report, pools);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].path).toBe("executiveSummary");
    expect(flagged[0].unsupported[0].value).toBe(7777);
  });

  it("stays quiet when every number is dataset- or fact-backed", () => {
    const report = baseReport({
      executiveSummary: "Beta spent PKR 40,000 of the account's PKR 100,000 total.",
    });
    expect(findUnsupportedProse(report, pools)).toHaveLength(0);
  });
});

// ── Repair turn ──────────────────────────────────────────────────────────────

const providerFact = (overrides = {}) => ({
  id: "F1",
  label: "Beta spend",
  kind: "observation",
  value: 40000,
  op: "sum",
  platform: "META",
  table: "campaign",
  rows: ["Beta"],
  metric: "spend",
  numerator: "",
  denominator: "",
  scale: 0,
  referenceCpa: 0,
  formula: "",
  ...overrides,
});

const providerReport = (executiveSummary) => ({
  executiveSummary,
  executiveFactIds: [],
  rootCause: "Conversion tracking is only wired on half the account.",
  rootCauseFactIds: [],
  facts: [providerFact()],
  findings: [
    {
      id: "AN-TRACKING-GAP",
      title: "Beta runs without usable conversion signal",
      severity: "HIGH",
      category: "tracking",
      campaignRefs: ["Beta"],
      entityRefs: [],
      claim: "Beta cannot attribute its reported conversions.",
      factIds: ["F1"],
      recommendation: "Install the pixel purchase event.",
      confidence: "high",
    },
  ],
  campaignDeepDives: [],
  ruleFindingDispositions: [],
  recommendations: [
    {
      priority: 1,
      action: "Fix tracking first.",
      expectedImpact: "Trustworthy CPA reads.",
      factIds: [],
    },
  ],
});

describe("runAnalyst prose repair turn", () => {
  afterEach(() => {
    delete process.env.ANALYST_PROSE_REPAIR;
  });

  const textMessage = (obj) => ({
    content: [{ type: "text", text: JSON.stringify(obj) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 500 },
  });

  it("asks for missing facts once, merges them, and verification rescues the sentence", async () => {
    const calls = [];
    const createMessage = async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return textMessage(
          providerReport(
            "Beta wastes PKR 5,400 of excess spend against the account's own efficiency baseline."
          )
        );
      }
      // Repair call: 40000 − 200 × 173 = 5400, recomputable → verifies.
      return textMessage({
        facts: [
          providerFact({
            id: "R1",
            label: "Beta excess spend vs baseline",
            op: "excess_spend",
            value: 5400,
            referenceCpa: 173,
            metric: "",
          }),
        ],
      });
    };

    const audit = auditFixture({});
    const run = await runAnalyst({ audit }, { createMessage });

    expect(calls).toHaveLength(2);
    expect(run.repair.attempted).toBe(true);
    expect(run.repair.factsAdded).toBe(1);
    expect(run.report.supplementalFigures).toHaveLength(1);
    // The repair request must name the unsupported number.
    const repairText = JSON.stringify(calls[1].messages.at(-1));
    expect(repairText).toContain("5,400");

    const { report: verified, droppedClaims } = verifyAnalystReport({
      report: run.report,
      audit,
    });
    expect(verified.executiveSummary).toContain("PKR 5,400");
    expect(droppedClaims).toHaveLength(0);
  });

  it("makes no repair call when every number is already supported", async () => {
    const calls = [];
    const createMessage = async (request) => {
      calls.push(request);
      return textMessage(providerReport("Beta spent PKR 40,000 without attributable results."));
    };
    const run = await runAnalyst({ audit: auditFixture({}) }, { createMessage });
    expect(calls).toHaveLength(1);
    expect(run.repair.attempted).toBe(false);
  });

  it("respects ANALYST_PROSE_REPAIR=false", async () => {
    process.env.ANALYST_PROSE_REPAIR = "false";
    const calls = [];
    const createMessage = async (request) => {
      calls.push(request);
      return textMessage(providerReport("Beta wastes PKR 5,400 of excess spend every period."));
    };
    const run = await runAnalyst({ audit: auditFixture({}) }, { createMessage });
    expect(calls).toHaveLength(1);
    expect(run.repair.attempted).toBe(false);
  });

  it("survives a failing repair call — the report still returns", async () => {
    const calls = [];
    const createMessage = async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        return textMessage(providerReport("Beta wastes PKR 5,400 of excess spend every period."));
      }
      throw new Error("simulated repair transport failure");
    };
    const run = await runAnalyst({ audit: auditFixture({}) }, { createMessage });
    expect(calls).toHaveLength(2);
    expect(run.repair.attempted).toBe(true);
    expect(run.repair.factsAdded).toBe(0);
    expect(run.report.executiveSummary).toContain("5,400");
  });
});
