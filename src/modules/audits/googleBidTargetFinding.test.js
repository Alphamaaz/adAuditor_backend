import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * GOOGLE-BID-002 — a Smart-bidding target that isn't holding (actual misses the
 * campaign's OWN set target). Distinct from GOOGLE-BID-001 (no cap at all): a
 * Maximize-Conversions campaign WITH a target CPA must NOT fire BID-001 — BID-002
 * owns it.
 */
const bidAudit = (campaigns, summary = { spend: 60000, conversions: 500, clicks: 20000, impressions: 700000, currency: "PKR" }) => ({
  id: "aud_bid2",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: summary.spend, conversions: summary.conversions },
      platforms: { GOOGLE: summary },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: campaigns,
          byLevel: { campaign: campaigns },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("GOOGLE-BID-002 — target vs. actual", () => {
  it("flags a Target CPA campaign whose actual CPA blows past its set target", () => {
    // target 100, actual 20000/100 = 200 → 100% over.
    const { findings } = runDeterministicAudit(
      bidAudit([
        { level: "campaign", name: "Search | Leads", status: "ACTIVE", bidStrategy: "TARGET_CPA", objective: "SEARCH", campaignId: "1", spend: 20000, results: 100, clicks: 6000, targetCpa: 100 },
      ])
    );
    const f = findings.find((x) => x.ruleId === "GOOGLE-BID-002");
    expect(f).toBeDefined();
    expect(f.severity).toBe("HIGH"); // ratio ≥ 1.6
    expect(f.evidence.targetCpa).toBe(100);
    expect(f.evidence.actualCpa).toBe(200);
    expect(f.evidence.percentOverTarget).toBe(100);
  });

  it("flags a Target ROAS campaign achieving well below its target", () => {
    // target 4x, actual 1.5x → 62% under.
    const { findings } = runDeterministicAudit(
      bidAudit([
        { level: "campaign", name: "Search | Shopping", status: "ACTIVE", bidStrategy: "TARGET_ROAS", objective: "SEARCH", campaignId: "1", spend: 20000, results: 120, clicks: 6000, roas: 1.5, targetRoas: 4 },
      ])
    );
    const f = findings.find((x) => x.ruleId === "GOOGLE-BID-002");
    expect(f).toBeDefined();
    expect(f.evidence.targetRoas).toBe(4);
    expect(f.evidence.actualRoas).toBe(1.5);
    expect(f.title).toMatch(/Target ROAS/i);
  });

  it("does not fire when the campaign meets its target", () => {
    const { findings } = runDeterministicAudit(
      bidAudit([
        { level: "campaign", name: "Search | Leads", status: "ACTIVE", bidStrategy: "TARGET_CPA", objective: "SEARCH", campaignId: "1", spend: 10000, results: 100, clicks: 6000, targetCpa: 110 }, // actual 100 ≤ target
      ])
    );
    expect(findings.find((x) => x.ruleId === "GOOGLE-BID-002")).toBeUndefined();
  });

  it("a Maximize Conversions campaign WITH a target CPA fires BID-002, not BID-001", () => {
    const { findings } = runDeterministicAudit(
      bidAudit([
        { level: "campaign", name: "Search | MaxConv+tCPA", status: "ACTIVE", bidStrategy: "MAXIMIZE_CONVERSIONS", objective: "SEARCH", campaignId: "1", spend: 20000, results: 100, clicks: 6000, targetCpa: 100 },
      ])
    );
    expect(findings.find((x) => x.ruleId === "GOOGLE-BID-002")).toBeDefined();
    expect(findings.find((x) => x.ruleId === "GOOGLE-BID-001")).toBeUndefined();
  });
});
