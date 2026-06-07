import { describe, it, expect } from "vitest";
import {
  buildComparisonFindings,
  buildCurrentSnapshot,
} from "./comparisonFindings.service.js";

const currentAudit = (over = {}) => ({
  id: "cur",
  adAccountId: over.adAccountId || "ME",
  adAccount: { name: over.adAccountName || "My Account" },
  completedAt: "2026-06-01",
  selectedPlatforms: ["META"],
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce" } },
  ruleFindings: over.ruleFindings || [],
});

const datasetOf = ({ spend, impressions, clicks, conversions }) => ({
  summary: { totals: { spend, impressions, clicks, conversions } },
});

const priorSummary = (over = {}) => ({
  auditId: over.auditId || "prev",
  adAccountId: over.adAccountId || "ME",
  adAccountName: over.adAccountName || "My Account",
  completedAt: over.completedAt || "2026-05-01",
  selectedPlatforms: ["META"],
  businessType: "eCommerce",
  spend: over.spend ?? 5000,
  impressions: over.impressions ?? 100000,
  clicks: over.clicks ?? 4000,
  conversions: over.conversions ?? 100,
  kpis: over.kpis,
  healthScore: over.healthScore ?? 70,
  criticalRuleIds: over.criticalRuleIds || [],
  schemaVersion: 3,
});

describe("buildComparisonFindings", () => {
  it("returns [] with no priors (first audit)", () => {
    const current = buildCurrentSnapshot({
      audit: currentAudit(),
      scores: { overall: 70 },
      dataset: datasetOf({ spend: 5000, impressions: 100000, clicks: 4000, conversions: 100 }),
    });
    expect(buildComparisonFindings({ current, priorSummaries: [] })).toEqual([]);
  });

  it("fires MEMORY-REGRESSION-001 when CPA worsened materially", () => {
    // prev cpa 50 (5000/100); current cpa 100 (5000/50) → +100%
    const current = buildCurrentSnapshot({
      audit: currentAudit(),
      scores: { overall: 65 },
      dataset: datasetOf({ spend: 5000, impressions: 100000, clicks: 4000, conversions: 50 }),
    });
    const findings = buildComparisonFindings({
      current,
      priorSummaries: [priorSummary({ conversions: 100, spend: 5000 })],
    });
    const reg = findings.find((f) => f.ruleId === "MEMORY-REGRESSION-001");
    expect(reg).toBeDefined();
    expect(reg.evidence.cpaDeltaPct).toBe(100);
    expect(reg.severity).toBe("HIGH");
  });

  it("fires MEMORY-IMPROVEMENT-001 when a critical was resolved", () => {
    const current = buildCurrentSnapshot({
      audit: currentAudit({ ruleFindings: [] }), // no current criticals
      scores: { overall: 80 },
      dataset: datasetOf({ spend: 5000, impressions: 100000, clicks: 4000, conversions: 120 }),
    });
    const findings = buildComparisonFindings({
      current,
      priorSummaries: [priorSummary({ criticalRuleIds: ["DATA-001"], healthScore: 60 })],
    });
    const imp = findings.find((f) => f.ruleId === "MEMORY-IMPROVEMENT-001");
    expect(imp).toBeDefined();
    expect(imp.evidence.resolvedCriticals).toContain("DATA-001");
  });

  it("fires PEER-CTR-001 when CTR is materially below a same-org peer", () => {
    // current ctr 1% (1000/100000); peer ctr 4% (4000/100000) → ~75% worse
    const current = buildCurrentSnapshot({
      audit: currentAudit({ adAccountId: "ME" }),
      scores: { overall: 70 },
      dataset: datasetOf({ spend: 5000, impressions: 100000, clicks: 1000, conversions: 50 }),
    });
    const findings = buildComparisonFindings({
      current,
      priorSummaries: [priorSummary({ adAccountId: "PEER", adAccountName: "Best Account", clicks: 4000 })],
    });
    const peer = findings.find((f) => f.ruleId === "PEER-CTR-001");
    expect(peer).toBeDefined();
    expect(peer.evidence.peerAccount).toBe("Best Account");
    expect(peer.evidence.ctrGapPct).toBeGreaterThanOrEqual(30);
  });

  it("does NOT fire PEER-CTR-001 on low impression sample", () => {
    const current = buildCurrentSnapshot({
      audit: currentAudit({ adAccountId: "ME" }),
      scores: { overall: 70 },
      dataset: datasetOf({ spend: 200, impressions: 2000, clicks: 20, conversions: 1 }),
    });
    const findings = buildComparisonFindings({
      current,
      priorSummaries: [priorSummary({ adAccountId: "PEER", impressions: 2000, clicks: 200 })],
    });
    expect(findings.find((f) => f.ruleId === "PEER-CTR-001")).toBeUndefined();
  });

  it("handles legacy v1 memory summaries without kpis (backward compat)", () => {
    const current = buildCurrentSnapshot({
      audit: currentAudit(),
      scores: { overall: 65 },
      dataset: datasetOf({ spend: 5000, impressions: 100000, clicks: 4000, conversions: 50 }),
    });
    // v1 summary: no kpis, has spendTotals only
    const legacy = {
      auditId: "old",
      adAccountId: "ME",
      completedAt: "2026-04-01",
      selectedPlatforms: ["META"],
      spendTotals: { total: 5000 },
      healthScore: 70,
      schemaVersion: 1,
    };
    // Should not throw; may or may not fire depending on derivable KPIs.
    expect(() =>
      buildComparisonFindings({ current, priorSummaries: [legacy] })
    ).not.toThrow();
  });
});
