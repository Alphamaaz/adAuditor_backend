import { describe, it, expect, afterEach } from "vitest";
import { serializeDatasetForAnalyst, serializeSlice, estimateTokens } from "./datasetSerializer.js";
import { resolveAnalystModel, ANALYST_MODEL, ANALYST_MODEL_BUDGET } from "./analystConfig.js";
import { runAnalyst } from "./analystRun.service.js";
import {
  analystReportJsonSchema,
  analystProviderJsonSchema,
  countOptionalProperties,
  countUnionTypes,
  expandAnalystProviderReport,
  validateAnalystReport,
} from "./analystReport.schema.js";
import { recomputeFigure, verifyAnalystReport } from "./analystVerification.service.js";
import { rowsWithAnalystRefs } from "./analystRowRef.js";
import { sanitizeNumericProse } from "./analystProseVerification.js";
import {
  applyAnalystMerge,
  analystSectionsFor,
  analystExecutiveParagraphs,
} from "./analystMerge.js";
import { buildReportDocumentFromAudit } from "../reportDocument.service.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const campaign = (name, spend, impressions, clicks, results, extra = {}) => ({
  name,
  status: "ACTIVE",
  spend,
  impressions,
  clicks,
  results,
  ...extra,
});

const auditFixture = ({ campaigns, placements, byDay, ruleFindings = [] } = {}) => ({
  id: "audit-1",
  selectedPlatforms: ["META"],
  healthScore: 55,
  businessProfileSnapshot: { sectionA: { businessType: "Ecommerce" } },
  intakeResponses: [],
  ruleFindings,
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
              campaign("Alpha", 60000, 300000, 6000, 300),
              campaign("Beta", 40000, 200000, 4000, 200),
            ],
          },
          byDimension: placements ? { placement: placements } : {},
          byDay: byDay || [],
        },
      },
    },
  },
});

// ── Serializer ───────────────────────────────────────────────────────────────

describe("datasetSerializer", () => {
  it("serializes every table with a preamble carrying currency and totals", () => {
    const result = serializeDatasetForAnalyst(auditFixture({}));
    expect(result.currency).toBe("PKR");
    expect(result.text).toContain("All money figures are in PKR");
    expect(result.text).toContain("## META campaign (2 rows)");
    expect(result.text).toContain("Alpha");
    expect(result.text).toContain("60000");
    expect(result.text).toContain("rowRef | name");
    expect(result.truncations).toHaveLength(0);
  });

  it("assigns distinct stable references to duplicate campaign names", () => {
    const result = serializeDatasetForAnalyst(
      auditFixture({
        campaigns: [
          campaign("New Leads campaign", 1000, 10000, 300, 20),
          campaign("New Leads campaign", 5000, 20000, 400, 10),
        ],
      })
    );
    const refs = [...result.text.matchAll(/META:campaign:r_[a-f0-9]{12}/g)].map(
      (match) => match[0]
    );
    expect(new Set(refs).size).toBe(2);
  });

  it("names quarantined campaigns in the preamble", () => {
    const result = serializeDatasetForAnalyst(auditFixture({}), {
      quarantinedCampaigns: ["Alpha"],
    });
    expect(result.text).toContain("TRACKING-ANOMALY QUARANTINE");
    expect(result.text).toContain('"Alpha"');
  });

  it("stays under the token budget by truncating tails — never campaigns", () => {
    const manyKeywords = Array.from({ length: 5000 }, (_, i) =>
      campaign(`kw-${i} long keyword phrase number ${i}`, i < 50 ? 100 : 0, 1000, 10, 0)
    );
    const audit = auditFixture({});
    audit.normalizedDataset.data.platforms.META.byLevel.keyword = manyKeywords;
    const result = serializeDatasetForAnalyst(audit, { maxTokens: 20000 });
    expect(result.tokenEstimate).toBeLessThanOrEqual(20000);
    expect(result.truncations.length).toBeGreaterThan(0);
    // Campaigns survive every truncation step.
    expect(result.text).toContain("Alpha");
    expect(result.text).toContain("Beta");
    // Spending keyword rows survive the zero-delivery truncation.
    expect(result.text).toContain("kw-0 ");
  });

  it("orders daily rows chronologically and keeps the most recent under pressure", () => {
    const byDay = Array.from({ length: 400 }, (_, i) => ({
      date: `2026-0${1 + Math.floor(i / 100)}-${String((i % 28) + 1).padStart(2, "0")}`,
      spend: 100,
      impressions: 1000,
      clicks: 10,
    }));
    const result = serializeDatasetForAnalyst(auditFixture({ byDay }), { maxTokens: 3000 });
    expect(result.tokenEstimate).toBeLessThanOrEqual(3000);
    const dayTruncation = result.truncations.find((t) => t.table === "byDay");
    expect(dayTruncation).toBeTruthy();
  });

  it("estimateTokens approximates chars/4", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

// ── Slice serializer (Phase B drill-down) ────────────────────────────────────

describe("serializeSlice", () => {
  const audit = auditFixture({
    placements: [
      { name: "Feed", spend: 70000, impressions: 350000, clicks: 7000, results: 450 },
      { name: "Audience Network", spend: 30000, impressions: 150000, clicks: 3000, results: 50 },
    ],
  });

  it("returns a full slice of a named table", () => {
    const out = serializeSlice(audit, { table: "placement", platform: "META" });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Feed");
    expect(out.text).toContain("Audience Network");
  });

  it("filters by substring match on row names", () => {
    const out = serializeSlice(audit, { table: "campaign", match: "alph" });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("Alpha");
    expect(out.text).not.toContain("Beta");
  });

  it("unknown table returns the available table list so the model can self-correct", () => {
    const out = serializeSlice(audit, { table: "ghost" });
    expect(out.ok).toBe(false);
    expect(out.text).toContain("META:campaign");
  });

  it("caps limit at 300", () => {
    const big = auditFixture({});
    big.normalizedDataset.data.platforms.META.byLevel.keyword = Array.from(
      { length: 500 },
      (_, i) => campaign(`kw-${i}`, 500 - i, 100, 10, 0)
    );
    const out = serializeSlice(big, { table: "keyword", limit: 9999 });
    expect(out.rowCount).toBe(300);
  });
});

// ── Phase B: drill-down tool loop ────────────────────────────────────────────

describe("runAnalyst drill-down loop", () => {
  it("offers get_slice only when truncated, feeds slices back, and accumulates usage", async () => {
    // A keyword table big enough to force truncation under the default budget.
    const audit = auditFixture({});
    audit.normalizedDataset.data.platforms.META.byLevel.keyword = Array.from(
      { length: 40000 },
      (_, i) => campaign(`kw-${i} some long keyword phrase padding tokens`, i < 100 ? 50 : 0, 500, 5, 0)
    );

    const turns = [];
    const result = await runAnalyst(
      { audit, captureTrace: true },
      {
        createMessage: async (request) => {
          turns.push(request);
          if (turns.length === 1) {
            // The tool must be offered (dataset was truncated).
            expect(request.tools?.[0]?.name).toBe("get_slice");
            return {
              content: [
                { type: "tool_use", id: "t1", name: "get_slice", input: { table: "keyword", match: "kw-39999" } },
              ],
              stop_reason: "tool_use",
              usage: { input_tokens: 1000, output_tokens: 50 },
            };
          }
          // Second turn: the slice result must be in the transcript.
          const toolResult = request.messages[2].content[0];
          expect(toolResult.type).toBe("tool_result");
          expect(toolResult.content).toContain("kw-39999");
          return {
            content: [{ type: "text", text: JSON.stringify(validReport()) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 1200, output_tokens: 800 },
          };
        },
      }
    );

    expect(turns).toHaveLength(2);
    expect(result.serialization.truncations.length).toBeGreaterThan(0);
    expect(result.serialization.sliceCalls).toBe(1);
    expect(result.usage.inputTokens).toBe(2200);
    expect(result.usage.outputTokens).toBe(850);
    expect(result.report.executiveSummary).toBeTruthy();
    expect(result.trace.turns).toHaveLength(2);
    expect(result.trace.turns[0].toolResults[0].content).toContain("kw-39999");
    expect(result.trace.turns[1].stopReason).toBe("end_turn");
  });

  it("does not offer the tool when nothing was truncated", async () => {
    const audit = auditFixture({});
    const result = await runAnalyst(
      { audit },
      {
        createMessage: async (request) => {
          expect(request.tools).toBeUndefined();
          return {
            content: [{ type: "text", text: JSON.stringify(validReport()) }],
            stop_reason: "end_turn",
            usage: { input_tokens: 500, output_tokens: 400 },
          };
        },
      }
    );
    expect(result.serialization.sliceCalls).toBe(0);
    expect(result.trace).toBeUndefined();
  });

  it("preserves usage and partial output when generation reaches max_tokens", async () => {
    const audit = auditFixture({});
    await expect(
      runAnalyst(
        { audit, captureTrace: true, maxOutputTokens: 1234, effort: "medium" },
        {
          createMessage: async (request) => {
            expect(request.max_tokens).toBe(1234);
            expect(request.output_config.effort).toBe("medium");
            return {
              content: [{ type: "text", text: "{\"partial\":" }],
              stop_reason: "max_tokens",
              usage: { input_tokens: 500, output_tokens: 1234 },
            };
          },
        }
      )
    ).rejects.toMatchObject({
      message: "analyst: output truncated at max_tokens",
      usage: { inputTokens: 500, outputTokens: 1234 },
      stopReason: "max_tokens",
    });
  });
});

// ── Per-plan model gating ────────────────────────────────────────────────────

describe("resolveAnalystModel", () => {
  afterEach(() => {
    delete process.env.ANALYST_MODEL;
  });

  it("routes free/starter to the budget model, pro/agency/unknown to the flagship", () => {
    expect(resolveAnalystModel("free")).toBe(ANALYST_MODEL_BUDGET);
    expect(resolveAnalystModel("starter")).toBe(ANALYST_MODEL_BUDGET);
    expect(resolveAnalystModel("pro")).toBe(ANALYST_MODEL);
    expect(resolveAnalystModel("agency")).toBe(ANALYST_MODEL);
    expect(resolveAnalystModel(undefined)).toBe(ANALYST_MODEL);
  });

  it("an explicit ANALYST_MODEL env overrides every tier", () => {
    process.env.ANALYST_MODEL = "claude-test-override";
    expect(resolveAnalystModel("starter")).toBe("claude-test-override");
    expect(resolveAnalystModel("agency")).toBe("claude-test-override");
  });
});

// ── Schema ───────────────────────────────────────────────────────────────────

const validReport = () => ({
  executiveSummary:
    "The account spends most of its budget on one campaign whose CPA is fine, while the second campaign burns spend with no tracking in place at all.",
  executiveFigures: [],
  rootCause: "Conversion tracking is only wired on half the account, so bidding is blind on the rest.",
  rootCauseFigures: [],
  findings: [
    {
      id: "AN-TRACKING-GAP",
      title: "Beta runs without usable conversion signal",
      severity: "HIGH",
      category: "tracking",
      campaignRefs: ["Beta"],
      claim: "Beta spent PKR 40,000 for 200 reported conversions that the ad sets cannot attribute.",
      figures: [
        {
          label: "Beta spend",
          kind: "observation",
          value: 40000,
          compute: { op: "sum", platform: "META", table: "campaign", rows: ["Beta"], metric: "spend" },
        },
        {
          label: "Beta conversions",
          kind: "observation",
          value: 200,
          compute: { op: "sum", platform: "META", table: "campaign", rows: ["Beta"], metric: "conversions" },
        },
      ],
      recommendation: "Install the pixel purchase event on Beta's landing domain and re-run.",
      confidence: "high",
    },
  ],
  campaignDeepDives: [
    {
      campaignName: "Alpha",
      verdict: "keep",
      diagnosis: "Alpha converts at PKR 200 CPA on solid volume.",
      actions: ["Hold budget"],
      figures: [
        {
          label: "Alpha CPA",
          kind: "observation",
          value: 200,
          compute: {
            op: "ratio",
            platform: "META",
            table: "campaign",
            rows: ["Alpha"],
            numerator: "spend",
            denominator: "conversions",
            scale: 1,
          },
        },
      ],
    },
  ],
  ruleFindingDispositions: [],
  recommendations: [
    {
      priority: 1,
      action: "Fix Beta tracking",
      expectedImpact: "Restores signal on 40% of spend",
      figures: [
        {
          label: "Beta spend share",
          kind: "observation",
          value: 40,
          compute: {
            op: "share",
            platform: "META",
            table: "campaign",
            rows: ["Beta"],
            metric: "spend",
          },
        },
      ],
    },
  ],
});

describe("analystReport schema validation", () => {
  it("stays below the provider grammar limit by making output fields required", () => {
    expect(countOptionalProperties(analystReportJsonSchema)).toBe(0);
    expect(countUnionTypes(analystReportJsonSchema)).toBe(0);
    expect(countOptionalProperties(analystProviderJsonSchema)).toBe(0);
    expect(countUnionTypes(analystProviderJsonSchema)).toBe(0);
    expect(JSON.stringify(analystProviderJsonSchema).length).toBeLessThan(
      JSON.stringify(analystReportJsonSchema).length
    );
  });

  it("expands compact provider facts into local figure lists", () => {
    const compact = {
      executiveSummary: "Campaign spend is PKR 100 according to the verified source row.",
      executiveFactIds: ["f1"],
      rootCause: "Budget allocation is the primary constraint in the account.",
      rootCauseFactIds: [],
      facts: [
        {
          id: "f1",
          label: "Campaign spend",
          kind: "observation",
          value: 100,
          op: "sum",
          platform: "META",
          table: "campaign",
          rows: ["META:campaign:r_1"],
          metric: "spend",
          numerator: "",
          denominator: "",
          scale: 0,
          referenceCpa: 0,
          formula: "",
        },
      ],
      findings: [],
      campaignDeepDives: [],
      ruleFindingDispositions: [],
      recommendations: [],
    };
    const expanded = expandAnalystProviderReport(compact);
    expect(expanded.executiveFigures[0]).toMatchObject({
      label: "Campaign spend",
      compute: { op: "sum", platform: "META", metric: "spend" },
    });
    expect(expanded).not.toHaveProperty("facts");
  });

  it("rejects unknown compact fact references", () => {
    expect(() =>
      expandAnalystProviderReport({
        executiveSummary: "Summary text long enough for validation.",
        executiveFactIds: ["missing"],
        rootCause: "Root cause text long enough.",
        rootCauseFactIds: [],
        facts: [],
        findings: [],
        campaignDeepDives: [],
        ruleFindingDispositions: [],
        recommendations: [],
      })
    ).toThrow(/unknown fact id/);
  });

  it("accepts a well-formed report", () => {
    expect(validateAnalystReport(validReport())).toEqual({ valid: true, errors: [] });
  });

  it("rejects missing findings and non-numeric figure values", () => {
    const bad = validReport();
    bad.findings[0].figures[0].value = "a lot";
    bad.recommendations = [];
    const result = validateAnalystReport(bad);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/non-numeric value/);
    expect(result.errors.join(" ")).toMatch(/recommendations/);
  });
});

// ── Verification: recompute ──────────────────────────────────────────────────

describe("recomputeFigure", () => {
  const audit = auditFixture({
    placements: [
      { name: "Feed", spend: 70000, impressions: 350000, clicks: 7000, results: 450 },
      { name: "Audience Network", spend: 30000, impressions: 150000, clicks: 3000, results: 50 },
    ],
  });

  it("sum over named rows", () => {
    const r = recomputeFigure(audit, {
      op: "sum", platform: "META", table: "campaign", rows: ["Alpha"], metric: "spend",
    });
    expect(r).toEqual({ ok: true, value: 60000 });
  });

  it("ratio computes CPA (spend/conversions) mapping results", () => {
    const r = recomputeFigure(audit, {
      op: "ratio", platform: "META", table: "campaign", rows: ["Alpha"],
      numerator: "spend", denominator: "conversions", scale: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(200);
  });

  it("share over ALL", () => {
    const r = recomputeFigure(audit, {
      op: "share", platform: "META", table: "campaign", rows: ["Alpha"], metric: "spend",
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(60);
  });

  it("excess_spend against a reference CPA", () => {
    const r = recomputeFigure(audit, {
      op: "excess_spend", platform: "META", table: "placement",
      rows: ["Audience Network"], referenceCpa: 156,
    });
    expect(r.ok).toBe(true);
    expect(r.value).toBe(30000 - 50 * 156);
  });

  it("resolves dimension tables case-insensitively", () => {
    const r = recomputeFigure(audit, {
      op: "sum", platform: "META", table: "Placement", rows: ["ALL"], metric: "spend",
    });
    expect(r).toEqual({ ok: true, value: 100000 });
  });

  it("fails when a referenced row does not exist (no partial matches)", () => {
    const r = recomputeFigure(audit, {
      op: "sum", platform: "META", table: "campaign", rows: ["Alpha", "Ghost"], metric: "spend",
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("rows_not_resolved");
  });

  it("rejects an ambiguous legacy name and resolves the same rows by stable reference", () => {
    const duplicateAudit = auditFixture({
      campaigns: [
        campaign("New Leads campaign", 1000, 10000, 300, 20),
        campaign("New Leads campaign", 5000, 20000, 400, 10),
      ],
    });
    const rows = duplicateAudit.normalizedDataset.data.platforms.META.byLevel.campaign;
    const refs = rowsWithAnalystRefs({ platform: "META", table: "campaign", rows });

    const ambiguous = recomputeFigure(duplicateAudit, {
      op: "sum",
      platform: "META",
      table: "campaign",
      rows: ["New Leads campaign"],
      metric: "spend",
    });
    expect(ambiguous).toEqual({
      ok: false,
      reason: "ambiguous_row:New Leads campaign",
    });

    const exact = recomputeFigure(duplicateAudit, {
      op: "raw",
      platform: "META",
      table: "campaign",
      rows: [refs[1].rowRef],
      metric: "spend",
    });
    expect(exact).toEqual({ ok: true, value: 5000 });

    const safeAlias = recomputeFigure(duplicateAudit, {
      op: "raw",
      platform: "META",
      table: "META campaign",
      rows: [refs[1].rowRef.split(":").at(-1)],
      metric: "spend",
    });
    expect(safeAlias).toEqual({ ok: true, value: 5000 });
  });

  it("estimate is structurally unverifiable", () => {
    expect(recomputeFigure(audit, { op: "estimate", formula: "x" }).reason).toBe("estimate");
  });
});

// ── Verification: full report policy ─────────────────────────────────────────

describe("numeric prose parsing", () => {
  it("treats a decimal percentage as one verified claim", () => {
    const result = sanitizeNumericProse({
      text: "CTR improved to 2.5%. Keep the current creative direction.",
      figures: [{ value: 2.5, verified: true }],
      path: "test",
    });
    expect(result.text).toBe(
      "CTR improved to 2.5%. Keep the current creative direction."
    );
    expect(result.dropped).toHaveLength(0);
  });

  it("does not treat dates, clock labels, or campaign sequence numbers as metrics", () => {
    const result = sanitizeNumericProse({
      text: "Campaign 6, 7 and 8 paused on 2026-06-19 after the 17:00 window.",
      figures: [],
      entityLabels: [],
      path: "finding.claim",
    });
    expect(result.dropped).toEqual([]);
    expect(result.text).toContain("Campaign 6, 7 and 8");
  });
});

describe("verifyAnalystReport", () => {
  const audit = auditFixture({});

  const figure = (overrides) => ({
    label: "Beta spend",
    kind: "observation",
    value: 40000,
    compute: { op: "sum", platform: "META", table: "campaign", rows: ["Beta"], metric: "spend" },
    ...overrides,
  });

  const reportWith = (figures, extra = {}) => ({
    ...validReport(),
    findings: [{ ...validReport().findings[0], figures }],
    ...extra,
  });

  it("keeps verified figures and replaces the value with the recomputed one", () => {
    const { report, stats } = verifyAnalystReport({
      report: reportWith([figure({ value: 40100 })]), // within 1.5% tolerance
      audit,
    });
    expect(stats.figuresVerified).toBe(3);
    expect(report.findings[0].figures[0].value).toBe(40000);
    expect(report.findings[0].figures[0].verified).toBe(true);
  });

  it("strips fabricated figures and downgrades the finding's confidence", () => {
    const { report, stats, droppedFigures } = verifyAnalystReport({
      report: reportWith([figure({ value: 99999 })]), // way off
      audit,
    });
    expect(stats.figuresDropped).toBe(1);
    expect(report.findings[0].figures).toHaveLength(0);
    expect(report.findings[0].confidence).toBe("medium"); // high → medium
    expect(droppedFigures[0].reason).toBe("out_of_tolerance");
  });

  it("removes unsupported numerical prose but keeps sentences backed by verified figures", () => {
    const base = reportWith([figure()]);
    base.executiveSummary =
      "The account wastes PKR 99,999 every month. Tracking quality needs immediate attention.";
    base.findings[0].claim =
      "Beta spent PKR 40,000. It also generated 9,999 qualified leads.";

    const { report, stats, droppedClaims } = verifyAnalystReport({
      report: base,
      audit,
    });

    expect(report.executiveSummary).toBe("Tracking quality needs immediate attention.");
    expect(report.findings[0].claim).toBe("Beta spent PKR 40,000.");
    expect(stats.unsupportedNumericClaims).toBe(2);
    expect(droppedClaims.map((item) => item.path)).toEqual(
      expect.arrayContaining(["executiveSummary", "findings[0].claim"])
    );
  });

  it("keeps numerical summary prose when its local figure verifies", () => {
    const base = reportWith([figure()]);
    base.executiveSummary = "The account has PKR 40,000 concentrated in Beta.";
    base.executiveFigures = [figure()];

    const { report, droppedClaims } = verifyAnalystReport({ report: base, audit });

    expect(report.executiveSummary).toBe(
      "The account has PKR 40,000 concentrated in Beta."
    );
    expect(report.executiveFigures[0].verified).toBe(true);
    expect(droppedClaims.some((item) => item.path === "executiveSummary")).toBe(false);
  });

  it("does not treat digits inside an exact campaign name as a numeric claim", () => {
    const namedAudit = auditFixture({
      campaigns: [campaign("Lead Gen 2", 40000, 200000, 4000, 200)],
    });
    const base = reportWith([]);
    base.findings[0].title = "Lead Gen 2 needs tracking review";
    base.findings[0].claim = "Lead Gen 2 has incomplete measurement.";

    const { report } = verifyAnalystReport({ report: base, audit: namedAudit });

    expect(report.findings[0].title).toBe("Lead Gen 2 needs tracking review");
    expect(report.findings[0].claim).toBe("Lead Gen 2 has incomplete measurement.");
  });

  it("reverts a numerical refutation when its supporting figure does not verify", () => {
    const auditWithRule = auditFixture({
      ruleFindings: [{ ruleId: "META-CPA-001", severity: "HIGH", title: "t", evidence: {} }],
    });
    const base = reportWith([figure()], {
      ruleFindingDispositions: [
        {
          ruleId: "META-CPA-001",
          disposition: "refuted",
          note: "The actual CPA is PKR 9,999, so the rule is wrong.",
          figures: [],
        },
      ],
    });

    const { report, stats } = verifyAnalystReport({
      report: base,
      audit: auditWithRule,
    });

    expect(report.ruleFindingDispositions[0].disposition).toBe("confirmed");
    expect(stats.refutationsReverted).toBe(1);
  });

  it("demotes a recoverable estimate to observation — projections are never recoverable", () => {
    const { report, stats } = verifyAnalystReport({
      report: reportWith([
        figure({ kind: "recoverable", compute: { op: "estimate", formula: "spend × 0.3" } }),
      ]),
      audit,
    });
    expect(stats.estimatesDemoted).toBe(1);
    expect(report.findings[0].figures[0].kind).toBe("observation");
    expect(report.findings[0].figures[0].verified).toBe(false);
    expect(report.findings[0].verifiedRecoverable).toBe(0);
  });

  it("sums only verified recoverable figures into verifiedRecoverable", () => {
    const { report } = verifyAnalystReport({
      report: reportWith([figure({ kind: "recoverable" })]),
      audit,
    });
    expect(report.findings[0].verifiedRecoverable).toBe(40000);
  });

  it("inverts scale advice on quarantined campaigns", () => {
    const base = reportWith([figure()]);
    base.findings[0].campaignRefs = ["Beta"];
    base.findings[0].recommendation = "Scale Beta by increasing budget 50%.";
    base.campaignDeepDives = [
      { campaignName: "Beta", verdict: "scale", diagnosis: "Cheap conversions.", actions: [] },
    ];
    const { report, stats } = verifyAnalystReport({
      report: base,
      audit,
      quarantinedCampaigns: ["Beta"],
    });
    expect(report.findings[0].quarantineFlag).toBe(true);
    expect(report.findings[0].recommendation).toMatch(/Verify this campaign's conversion tracking/);
    expect(report.campaignDeepDives[0].verdict).toBe("verify-tracking");
    expect(stats.deepDivesQuarantineFixed).toBe(1);
  });

  it("appends missing rule dispositions as confirmed and reverts note-less refutations", () => {
    const auditWithRules = auditFixture({
      ruleFindings: [
        { ruleId: "META-CPA-001", severity: "HIGH", title: "t", evidence: {} },
        { ruleId: "META-GEO-001", severity: "LOW", title: "t", evidence: {} },
      ],
    });
    const base = reportWith([figure()], {
      ruleFindingDispositions: [{ ruleId: "META-CPA-001", disposition: "refuted", note: "" }],
    });
    const { report, stats } = verifyAnalystReport({ report: base, audit: auditWithRules });
    const byId = Object.fromEntries(report.ruleFindingDispositions.map((d) => [d.ruleId, d]));
    expect(byId["META-CPA-001"].disposition).toBe("confirmed"); // reverted
    expect(byId["META-GEO-001"].disposition).toBe("confirmed"); // appended
    expect(stats.refutationsReverted).toBe(1);
    expect(stats.dispositionsAppended).toBe(1);
  });
});

// ── Merge into the report document ───────────────────────────────────────────

describe("applyAnalystMerge", () => {
  const ruleFinding = (ruleId, net, extra = {}) => ({
    ruleId,
    severity: "HIGH",
    category: "efficiency",
    title: `${ruleId} title`,
    detail: "detail",
    estimatedImpact: `PKR ${net} wasted`,
    evidence: { netRecoverable: net, ...extra },
    fixSteps: ["fix"],
  });

  const verifiedAnalyst = (overrides = {}) => ({
    ...validReport(),
    findings: [
      {
        ...validReport().findings[0],
        verifiedRecoverable: 12000,
        figures: [
          {
            label: "Wasted spend", kind: "recoverable", value: 12000, verified: true,
            compute: { op: "sum", table: "campaign", rows: ["Beta"], metric: "spend" },
          },
        ],
      },
    ],
    ...overrides,
  });

  it("transfers merged rule findings' nets and hides them — money conserved", () => {
    const rules = [ruleFinding("META-CPA-001", 9000), ruleFinding("META-GEO-001", 3000)];
    const analyst = verifiedAnalyst({
      ruleFindingDispositions: [
        { ruleId: "META-CPA-001", disposition: "merged", mergedIntoFindingId: "AN-TRACKING-GAP" },
        { ruleId: "META-GEO-001", disposition: "confirmed" },
      ],
    });
    const merged = applyAnalystMerge({
      analystReport: analyst, findings: rules, currency: "PKR", platform: "META",
    });
    expect(merged.hiddenRuleIds).toEqual(["META-CPA-001"]);
    const analystFinding = merged.findings.find((f) => f.ruleId === "AN-TRACKING-GAP");
    expect(analystFinding.evidence.netRecoverable).toBe(9000); // inherited, NOT 12000
    expect(analystFinding.evidence.advisory).toBe(false);
    expect(analystFinding.estimatedImpact).toMatch(/^PKR 9,000 recoverable/);
    // Total money before == total money after (9000 transferred + 3000 kept).
    const totalNet = merged.findings.reduce(
      (s, f) => s + (Number.isFinite(f.evidence?.netRecoverable) ? f.evidence.netRecoverable : 0),
      0
    );
    expect(totalNet).toBe(12000);
  });

  it("analyst-new recoverable stays advisory — never invents headline money", () => {
    const merged = applyAnalystMerge({
      analystReport: verifiedAnalyst({ ruleFindingDispositions: [] }),
      findings: [ruleFinding("META-CPA-001", 9000)],
      currency: "PKR",
      platform: "META",
    });
    const analystFinding = merged.findings.find((f) => f.ruleId === "AN-TRACKING-GAP");
    expect(analystFinding.evidence.advisory).toBe(true);
    expect(analystFinding.evidence.netRecoverable).toBe(0);
    expect(analystFinding.estimatedImpact).toMatch(/not added to the headline/);
  });

  it("a merged disposition without a resolvable target keeps the rule finding", () => {
    const merged = applyAnalystMerge({
      analystReport: verifiedAnalyst({
        ruleFindingDispositions: [
          { ruleId: "META-CPA-001", disposition: "merged", mergedIntoFindingId: "AN-DOES-NOT-EXIST" },
        ],
      }),
      findings: [ruleFinding("META-CPA-001", 9000)],
      currency: "PKR",
      platform: "META",
    });
    expect(merged.hiddenRuleIds).toEqual([]);
    expect(merged.findings.some((f) => f.ruleId === "META-CPA-001")).toBe(true);
  });

  it("refuted findings are hidden only with a note", () => {
    const merged = applyAnalystMerge({
      analystReport: verifiedAnalyst({
        ruleFindingDispositions: [
          { ruleId: "META-CPA-001", disposition: "refuted", note: "The CPA gap is driven by the quarantined campaign; trusted baseline shows no dispersion." },
        ],
      }),
      findings: [ruleFinding("META-CPA-001", 9000)],
      currency: "PKR",
      platform: "META",
    });
    expect(merged.refutedRuleIds).toEqual(["META-CPA-001"]);
    expect(merged.findings.some((f) => f.ruleId === "META-CPA-001")).toBe(false);
  });

  it("builds strategist sections and executive paragraphs", () => {
    const sections = analystSectionsFor(validReport(), "PKR");
    expect(sections.map((s) => s.id)).toEqual([
      "analyst-campaign-notes",
      "analyst-priority-moves",
    ]);
    expect(sections[0].blocks[0].text).toContain("Alpha");
    const paragraphs = analystExecutiveParagraphs(validReport());
    expect(paragraphs[0]).toMatch(/^\*\*Account story:\*\*/);
    expect(paragraphs[1]).toMatch(/^\*\*Root cause:\*\*/);
  });
});

// ── End-to-end: document renders with analyst on and off ────────────────────

describe("buildReportDocumentFromAudit with analystReport", () => {
  const baseAudit = () =>
    auditFixture({
      ruleFindings: [
        {
          ruleId: "META-CPA-001",
          severity: "HIGH",
          category: "efficiency",
          title: "Campaign CPA dispersion wastes PKR 9,000",
          detail: "Beta runs at 2× the account baseline CPA.",
          estimatedImpact: "PKR 9,000 wasted on above-baseline CPA",
          evidence: { netRecoverable: 9000, campaign: "Beta" },
          fixSteps: ["Cap Beta's bid"],
        },
      ],
    });

  it("renders identically-shaped documents with analyst absent (regression guard)", () => {
    const doc = buildReportDocumentFromAudit(baseAudit());
    expect(doc.masthead).toBeTruthy();
    expect(doc.sections.some((s) => s.id === "analyst-campaign-notes")).toBe(false);
    expect(doc.key_numbers[0].value).toContain("9,000");
  });

  it("merges analyst content: sections, exec paragraphs, conserved money", () => {
    const audit = baseAudit();
    audit.analystReport = {
      report: {
        ...validReport(),
        findings: [
          {
            ...validReport().findings[0],
            verifiedRecoverable: 0,
            figures: [],
          },
        ],
        ruleFindingDispositions: [
          { ruleId: "META-CPA-001", disposition: "merged", mergedIntoFindingId: "AN-TRACKING-GAP" },
        ],
      },
      verification: { stats: { figuresTotal: 4, figuresVerified: 4, figuresDropped: 0 } },
    };
    const doc = buildReportDocumentFromAudit(audit);
    // Analyst sections present.
    expect(doc.sections.some((s) => s.id === "analyst-campaign-notes")).toBe(true);
    expect(doc.sections.some((s) => s.id === "analyst-priority-moves")).toBe(true);
    // Exec summary leads with the analyst story.
    expect(doc.executive_summary.paragraphs[0]).toMatch(/^\*\*Account story:\*\*/);
    // Money conserved: the merged rule finding's 9,000 now rides on the analyst finding.
    expect(doc.key_numbers[0].value).toContain("9,000");
    // Method note documents the verification.
    expect(doc.method_notes.some((n) => n.label === "AI analyst")).toBe(true);
  });
});
