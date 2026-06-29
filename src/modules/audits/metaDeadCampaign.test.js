import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import {
  normalizeStructureOnlyCampaigns,
  enrichCampaignsWithStructure,
} from "../platformConnections/metaNormalizer.service.js";

/**
 * Dead-campaign capture: the Meta insights endpoint omits campaigns that had no
 * delivery in the window, so they were invisible to the audit. They are now
 * pulled from the /campaigns structure endpoint into a SEPARATE bucket
 * (campaignStructureOnly) — never merged into the spending set — and surfaced by
 * META-HYGIENE-002 as structural clutter only.
 */

describe("normalizeStructureOnlyCampaigns", () => {
  const structure = [
    { name: "LP Leads A", effective_status: "ACTIVE", objective: "OUTCOME_LEADS" },
    { name: "Old Test PAUSED", effective_status: "PAUSED", objective: "OUTCOME_TRAFFIC", daily_budget: "500" },
    { name: "Never Launched", status: "PAUSED", objective: "OUTCOME_LEADS" },
  ];
  const insights = [{ name: "LP Leads A" }];

  it("returns only campaigns absent from the insight rows", () => {
    const out = normalizeStructureOnlyCampaigns(structure, insights);
    expect(out.map((c) => c.name).sort()).toEqual(["Never Launched", "Old Test PAUSED"]);
  });

  it("zeros every metric and flags neverDelivered", () => {
    const out = normalizeStructureOnlyCampaigns(structure, insights);
    for (const c of out) {
      expect(c.spend).toBe(0);
      expect(c.impressions).toBe(0);
      expect(c.results).toBe(0);
      expect(c.cpa).toBeNull();
      expect(c.neverDelivered).toBe(true);
      expect(c.level).toBe("campaign");
    }
  });

  it("carries status and budget through for the hygiene narrative", () => {
    const out = normalizeStructureOnlyCampaigns(structure, insights);
    const paused = out.find((c) => c.name === "Old Test PAUSED");
    expect(paused.status).toBe("PAUSED");
    expect(paused.budget).toBe(500);
  });

  it("is empty when every structure campaign delivered", () => {
    const allDelivered = [{ name: "LP Leads A" }, { name: "Old Test PAUSED" }, { name: "Never Launched" }];
    expect(normalizeStructureOnlyCampaigns(structure, allDelivered)).toEqual([]);
  });

  it("does not double-count: enrich keeps delivered, structure-only keeps the rest", () => {
    const delivered = enrichCampaignsWithStructure(
      [{ level: "campaign", name: "LP Leads A", spend: 60000, results: 520 }],
      structure
    );
    const dead = normalizeStructureOnlyCampaigns(structure, [{ name: "LP Leads A" }]);
    const allNames = [...delivered.map((c) => c.name), ...dead.map((c) => c.name)];
    expect(new Set(allNames).size).toBe(allNames.length); // no overlap
    expect(allNames).toContain("LP Leads A");
    expect(allNames).toContain("Never Launched");
  });
});

const auditWithDeadCampaigns = (deadCount = 3) => {
  const campaigns = [
    { level: "campaign", name: "LP Leads A", status: "ACTIVE", spend: 60000, impressions: 120000, clicks: 4800, results: 520, resultFamily: "lead", cpa: 115 },
    { level: "campaign", name: "LP Leads B", status: "ACTIVE", spend: 50000, impressions: 100000, clicks: 4000, results: 450, resultFamily: "lead", cpa: 111 },
  ];
  const adsets = [
    { level: "adset", name: "a1", campaignName: "LP Leads A", spend: 60000, impressions: 120000, results: 520 },
    { level: "adset", name: "b1", campaignName: "LP Leads B", spend: 50000, impressions: 100000, results: 450 },
  ];
  const dead = Array.from({ length: deadCount }, (_, i) => ({
    level: "campaign",
    name: `Dead Campaign ${i + 1}`,
    status: "PAUSED",
    spend: 0,
    impressions: 0,
    clicks: 0,
    results: 0,
    neverDelivered: true,
  }));
  return {
    id: "aud_dead",
    selectedPlatforms: ["META"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", lookbackDays: 30 } },
    intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend: 110000, conversions: 970, currency: "PKR" },
        platforms: { META: { spend: 110000, conversions: 970, clicks: 8800, impressions: 220000, currency: "PKR" } },
      },
      data: {
        platforms: {
          META: {
            records: [...campaigns, ...adsets],
            byLevel: { campaign: campaigns, adset: adsets, campaignStructureOnly: dead },
            byDimension: {},
            byDay: [],
            currency: "PKR",
          },
        },
      },
    },
  };
};

describe("META-HYGIENE-002 dead campaigns", () => {
  it("fires with the dead-campaign count and examples", () => {
    const { findings } = runDeterministicAudit(auditWithDeadCampaigns(3));
    const f = findings.find((x) => x.ruleId === "META-HYGIENE-002");
    expect(f).toBeDefined();
    expect(f.severity).toBe("LOW");
    expect(f.evidence.deadCampaignCount).toBe(3);
    expect(f.evidence.examples).toContain("Dead Campaign 1");
  });

  it("does not fire when there are no dead campaigns", () => {
    const audit = auditWithDeadCampaigns(0);
    audit.normalizedDataset.data.platforms.META.byLevel.campaignStructureOnly = [];
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((x) => x.ruleId === "META-HYGIENE-002")).toBeUndefined();
  });

  it("dead campaigns never reach the account baseline (CPA stays on live campaigns)", () => {
    const { findings } = runDeterministicAudit(auditWithDeadCampaigns(40));
    // The live blended CPA is ~113 (110000 / 970). A dead-campaign leak would
    // crater it toward zero. Assert no finding cites an impossibly cheap baseline.
    const baselineCited = findings
      .map((f) => f.evidence?.accountBaselineCpa ?? f.evidence?.baselineCpa)
      .filter((v) => typeof v === "number");
    for (const v of baselineCited) expect(v).toBeGreaterThan(50);
  });
});
