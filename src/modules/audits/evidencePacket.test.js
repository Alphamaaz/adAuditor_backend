import { describe, it, expect } from "vitest";
import { buildEvidencePacket, __test__ } from "./evidencePacket.service.js";
import { validateAiReportFactuality } from "./aiReportValidation.service.js";

const auditFixture = () => ({
  id: "aud_1",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "MANUAL_UPLOAD",
  healthScore: 62,
  categoryScores: { GOOGLE: { score: 62 } },
  businessProfileSnapshot: {
    sectionA: { businessType: "eCommerce", monthlyBudget: 5000, targetCpa: 50, brandTerms: "Acme" },
  },
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
      title: "$1,200 of search-term spend produced zero conversions",
      detail: "12 terms wasted $1,200.",
      evidence: { wastedSpend: 1200, wastedTermCount: 12 },
      estimatedImpact: "$1,200 in identified waste. Recovers 80% ($960).",
      fixSteps: ["Add negatives"],
    },
    {
      ruleId: "GOOGLE-BRAND-SEPARATION-001",
      platform: "GOOGLE",
      severity: "MEDIUM",
      category: "Campaign Structure",
      title: "Brand mixed across $300 of spend",
      evidence: { mixedSpend: 300 },
      estimatedImpact: "Distorts ROAS on $300 of spend.",
      fixSteps: ["Separate brand"],
    },
  ],
});

describe("evidencePacket", () => {
  it("sorts findings by dollar impact desc", () => {
    const packet = buildEvidencePacket(auditFixture());
    expect(packet.topFindings[0].ruleId).toBe("GOOGLE-SEARCH-TERM-WASTE-001");
    expect(packet.topFindings[0].estimatedImpactDollars).toBe(1200);
  });

  it("collects verified dollar numbers from evidence + impact + summary + profile", () => {
    const packet = buildEvidencePacket(auditFixture());
    expect(packet.verifiedNumbers).toContain(1200);
    expect(packet.verifiedNumbers).toContain(960);
    expect(packet.verifiedNumbers).toContain(300);
    expect(packet.verifiedNumbers).toContain(5000); // spend + budget
    expect(packet.verifiedNumbers).toContain(50); // targetCpa
  });

  it("excludes raw rows", () => {
    const packet = buildEvidencePacket(auditFixture());
    expect(packet.contextLimits.rawRowsIncluded).toBe(false);
  });

  it("flags tracking confidence cleanly when no tracking findings", () => {
    const packet = buildEvidencePacket(auditFixture());
    expect(packet.dataConfidence.metricsReliable).toBe(true);
  });
});

describe("validateAiReportFactuality", () => {
  it("passes when all dollar figures are verified", () => {
    const packet = buildEvidencePacket(auditFixture());
    const output = {
      executiveSummary: ["You wasted $1,200 on zero-conversion search terms; recovering $960 is the top priority."],
    };
    const r = validateAiReportFactuality({ output, verifiedNumbers: packet.verifiedNumbers });
    expect(r.ok).toBe(true);
    expect(r.fabricatedNumbers).toEqual([]);
  });

  it("flags an invented dollar figure", () => {
    const packet = buildEvidencePacket(auditFixture());
    const output = {
      executiveSummary: ["You are wasting $9,999 per month."], // not in evidence
    };
    const r = validateAiReportFactuality({ output, verifiedNumbers: packet.verifiedNumbers });
    expect(r.ok).toBe(false);
    expect(r.fabricatedNumbers).toContain(9999);
  });

  it("tolerates rounding drift within ±1", () => {
    const r = validateAiReportFactuality({
      output: { s: "about $1,201" },
      verifiedNumbers: [1200],
    });
    expect(r.ok).toBe(true);
  });
});

describe("evidencePacket comparison block", () => {
  it("includes self-over-time + peer comparison from prior summaries", () => {
    const audit = {
      ...auditFixture(),
      adAccountId: "ME",
      adAccount: { name: "My Account" },
      completedAt: "2026-06-01",
      healthScore: 65,
    };
    // Make current CTR low (1%): clicks 1000 / impressions 100000.
    audit.normalizedDataset.summary.totals = {
      spend: 5000, impressions: 100000, clicks: 1000, conversions: 50,
    };
    const priorAudits = [
      {
        auditId: "prev", adAccountId: "ME", adAccountName: "My Account",
        completedAt: "2026-05-01", selectedPlatforms: ["GOOGLE"],
        businessType: "eCommerce", spend: 5000, impressions: 100000,
        clicks: 1000, conversions: 100, healthScore: 70,
        kpis: { ctr: 1, cpc: 5, cpa: 50, cpm: 50, roas: null },
        criticalRuleIds: [], schemaVersion: 3,
      },
      {
        auditId: "peer1", adAccountId: "PEER", adAccountName: "Best Account",
        completedAt: "2026-05-15", selectedPlatforms: ["GOOGLE"],
        businessType: "eCommerce", spend: 5000, impressions: 100000,
        clicks: 4000, conversions: 100, healthScore: 85,
        kpis: { ctr: 4, cpc: 1.25, cpa: 50, cpm: 50, roas: null },
        criticalRuleIds: [], schemaVersion: 3,
      },
    ];
    const packet = buildEvidencePacket(audit, { priorAudits });
    expect(packet.comparison).toBeDefined();
    expect(packet.comparison.selfOverTime).not.toBeNull();
    expect(packet.comparison.selfOverTime.previousAuditId).toBe("prev");
    expect(packet.comparison.peer).not.toBeNull();
    expect(packet.comparison.peer.peer.adAccountName).toBe("Best Account");
    expect(packet.comparison.peer.strongestGap.metric).toBe("CTR");
  });

  it("comparison blocks are null on a first audit (no priors)", () => {
    const packet = buildEvidencePacket(auditFixture(), { priorAudits: [] });
    expect(packet.comparison.selfOverTime).toBeNull();
    expect(packet.comparison.peer).toBeNull();
  });
});

describe("parseImpactDollars", () => {
  it("parses leading dollar magnitude", () => {
    expect(__test__.parseImpactDollars("$4,280 in waste")).toBe(4280);
    expect(__test__.parseImpactDollars("no dollar here")).toBe(0);
  });
});
