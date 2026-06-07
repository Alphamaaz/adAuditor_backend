import { describe, it, expect } from "vitest";
import {
  deriveKpis,
  spendBand,
  normalizeSnapshotFromMemory,
  pickPeer,
  peerComparison,
  memoryDelta,
  buildComparisonFacts,
} from "./auditComparison.js";

describe("deriveKpis", () => {
  it("computes ctr/cpc/cpa/cpm", () => {
    const k = deriveKpis({ spend: 1000, impressions: 100000, clicks: 2000, conversions: 50 });
    expect(k.ctr).toBe(2);
    expect(k.cpc).toBe(0.5);
    expect(k.cpa).toBe(20);
    expect(k.cpm).toBe(10);
  });
});

describe("spendBand", () => {
  it("bands spend", () => {
    expect(spendBand(500)).toBe("0-1k");
    expect(spendBand(5000)).toBe("1k-10k");
    expect(spendBand(50000)).toBe("10k-100k");
    expect(spendBand(500000)).toBe("100k+");
  });
});

const memSummary = (over = {}) => ({
  auditId: over.auditId || "a1",
  adAccountId: over.adAccountId || "acc1",
  adAccountName: over.adAccountName || "Account 1",
  completedAt: over.completedAt || "2026-05-01",
  selectedPlatforms: over.selectedPlatforms || ["META"],
  businessType: over.businessType || "eCommerce",
  spend: over.spend ?? 5000,
  impressions: over.impressions ?? 100000,
  clicks: over.clicks ?? 4000,
  conversions: over.conversions ?? 100,
  kpis: over.kpis,
  healthScore: over.healthScore ?? 70,
  criticalRuleIds: over.criticalRuleIds || [],
  schemaVersion: over.schemaVersion ?? 3,
});

describe("pickPeer", () => {
  it("picks same-platform, same-business-type, different account", () => {
    const current = normalizeSnapshotFromMemory(memSummary({ adAccountId: "ME", spend: 6000 }));
    const candidates = [
      normalizeSnapshotFromMemory(memSummary({ adAccountId: "OTHER1", businessType: "Lead Gen", spend: 6000 })),
      normalizeSnapshotFromMemory(memSummary({ adAccountId: "OTHER2", businessType: "eCommerce", spend: 6000 })),
    ];
    const pick = pickPeer({ current, candidates });
    expect(pick.peer.adAccountId).toBe("OTHER2"); // same business type wins
    expect(pick.reasons).toContain("same business type");
  });

  it("excludes the current account + different platforms", () => {
    const current = normalizeSnapshotFromMemory(memSummary({ adAccountId: "ME" }));
    const candidates = [
      normalizeSnapshotFromMemory(memSummary({ adAccountId: "ME" })), // self
      normalizeSnapshotFromMemory(memSummary({ adAccountId: "G1", selectedPlatforms: ["GOOGLE"] })), // other platform
    ];
    expect(pickPeer({ current, candidates })).toBeNull();
  });

  it("returns null on empty candidates", () => {
    const current = normalizeSnapshotFromMemory(memSummary());
    expect(pickPeer({ current, candidates: [] })).toBeNull();
  });
});

describe("peerComparison", () => {
  it("identifies CTR underperformance vs peer", () => {
    const current = normalizeSnapshotFromMemory(memSummary({ clicks: 2000 })); // ctr 2%
    const peer = normalizeSnapshotFromMemory(memSummary({ adAccountId: "P", clicks: 4000 })); // ctr 4%
    const cmp = peerComparison({ current, peer });
    expect(cmp.strongestGap.metric).toBe("CTR");
    expect(cmp.confidence).toBe("high"); // both 100k impressions
  });
});

describe("memoryDelta", () => {
  it("computes CPA delta + resolved criticals", () => {
    const previous = normalizeSnapshotFromMemory(
      memSummary({ conversions: 100, spend: 5000, criticalRuleIds: ["DATA-001", "BID-005"], healthScore: 60 })
    ); // cpa 50
    const current = normalizeSnapshotFromMemory(
      memSummary({ conversions: 50, spend: 5000, criticalRuleIds: ["BID-005"], healthScore: 70 })
    ); // cpa 100
    const d = memoryDelta({ current, previous });
    expect(d.deltas.cpaPct).toBe(100); // 50→100 = +100%
    expect(d.resolvedCriticals).toEqual(["DATA-001"]);
    expect(d.repeatedCriticals).toEqual(["BID-005"]);
    expect(d.healthScoreDelta).toBe(10);
  });
});

describe("buildComparisonFacts", () => {
  it("returns null blocks when no priors", () => {
    const current = normalizeSnapshotFromMemory(memSummary());
    const facts = buildComparisonFacts({ current, priorSnapshots: [] });
    expect(facts.selfOverTime).toBeNull();
    expect(facts.peer).toBeNull();
  });
});
