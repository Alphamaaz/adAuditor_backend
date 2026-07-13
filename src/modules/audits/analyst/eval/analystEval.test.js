import { describe, expect, it } from "vitest";
import {
  currencyViolations,
  gradeAnalystConsistency,
  gradeAnalystTrial,
  summarizeFixtureTrials,
} from "./analystEval.js";

const figure = (value = 100) => ({
  label: "Spend",
  kind: "observation",
  value,
  verified: true,
  compute: { op: "sum", table: "campaign", rows: ["ALL"], metric: "spend" },
});

const report = (overrides = {}) => ({
  executiveSummary: "The account spends PKR 100 and the verified findings explain the main constraint.",
  executiveFigures: [figure()],
  rootCause: "Budget concentration is limiting efficient delivery across the strongest audience segments.",
  rootCauseFigures: [],
  findings: [
    {
      id: "AN-BUDGET",
      category: "budget",
      title: "Budget concentration limits delivery",
      claim: "The strongest audience receives insufficient delivery.",
      figures: [figure()],
      recommendation: "Consolidate the weakest campaigns.",
      confidence: "high",
      verifiedRecoverable: 0,
    },
  ],
  campaignDeepDives: [
    { campaignName: "Campaign 1", verdict: "fix", diagnosis: "Budget is fragmented.", actions: ["Consolidate delivery."], figures: [figure()] },
  ],
  recommendations: [
    { priority: 1, action: "Consolidate weak campaigns", expectedImpact: "More stable delivery and cleaner learning", figures: [figure()] },
    { priority: 2, action: "Test the strongest audience", expectedImpact: "Improved allocation confidence", figures: [] },
    { priority: 3, action: "Review tracking quality", expectedImpact: "More reliable optimization decisions", figures: [] },
  ],
  ruleFindingDispositions: [
    { ruleId: "RULE-1", disposition: "confirmed", figures: [] },
  ],
  ...overrides,
});

const input = (overrides = {}) => ({
  audit: {
    ruleFindings: [
      { ruleId: "RULE-1", category: "budget", title: "Budget concentration", detail: "Delivery is fragmented." },
    ],
  },
  run: { serialization: { currency: "PKR" } },
  verified: {
    report: report(),
    stats: {
      figuresTotal: 4,
      figuresVerified: 4,
      figuresDropped: 0,
      estimatesDemoted: 0,
      proseFieldsChecked: 10,
      proseSentencesDropped: 0,
      unsupportedNumericClaims: 0,
    },
    droppedClaims: [],
    droppedFigures: [],
  },
  ...overrides,
});

describe("analyst live eval graders", () => {
  it("passes a grounded, correctly localized report", () => {
    const result = gradeAnalystTrial(input());
    expect(result.pass).toBe(true);
    expect(result.hardFailures).toEqual([]);
  });

  it("hard-fails wrong currency and unsupported money", () => {
    const data = input();
    data.verified.report.executiveSummary = "The account wastes USD 999.";
    data.verified.droppedClaims = [
      { path: "executiveSummary", sentence: "The account wastes USD 999.", unsupported: [{ value: 999 }] },
    ];
    const result = gradeAnalystTrial(data);
    expect(result.hardFailures).toContain("wrong_currency:USD");
    expect(result.hardFailures).toContain("unsupported_money:1");
    expect(result.pass).toBe(false);
  });

  it("measures cross-trial agreement and strict pass^k", () => {
    const trials = [1, 2, 3].map(() => ({
      grade: { pass: true, total: 0.95 },
      verified: { report: report() },
    }));
    const consistency = gradeAnalystConsistency(trials);
    expect(consistency.pass).toBe(true);
    const summary = summarizeFixtureTrials(trials);
    expect(summary.passAtK).toBe(true);
    expect(summary.passPowK).toBe(true);
    expect(summary.pass).toBe(true);
  });

  it("fails consistency when findings and money vary materially", () => {
    const changed = report({
      rootCause: "Tracking quality is the primary measurement constraint.",
      findings: [{ ...report().findings[0], id: "AN-TRACKING", category: "tracking", verifiedRecoverable: 900 }],
      recommendations: [{ priority: 1, action: "Verify pixel events", expectedImpact: "Reliable conversion data", figures: [] }],
    });
    const consistency = gradeAnalystConsistency([
      { verified: { report: report() } },
      { verified: { report: changed } },
    ]);
    expect(consistency.pass).toBe(false);
    expect(consistency.warnings).toContain("unstable_findings");
    expect(consistency.warnings).toContain("unstable_recoverable_money");
  });

  it("detects currency symbols as well as ISO codes", () => {
    expect(currencyViolations({ executiveSummary: "$500 and EUR 20" }, "PKR")).toEqual([
      "USD",
      "EUR",
    ]);
  });
});
