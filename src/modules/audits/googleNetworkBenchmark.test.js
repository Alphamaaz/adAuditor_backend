import { describe, it, expect } from "vitest";
import { runDeterministicAudit, resolveGoogleNetwork, getBenchmark, GOOGLE_NETWORK_BENCHMARKS } from "./auditEngine.service.js";

/**
 * Network-aware Google benchmarking. Google CTR/CVR are dominated by the delivery
 * network (Search ~6.6% vs Display ~0.5% CTR — a ~13× gap), so a Display account
 * must be judged against DISPLAY norms, never the Search bar. Otherwise a normal
 * Display CTR (~0.5%) reads "critically below" a 6% Search benchmark — a false
 * finding on the exact account type common in this corpus.
 */
const googleAccount = ({ channelType, ctrPct, businessType = "Lead Gen", name = "C1" }) => {
  const impressions = 1_000_000;
  const clicks = Math.round(impressions * (ctrPct / 100));
  const spend = 50000, conversions = Math.max(1, Math.round(clicks * 0.02));
  const campaign = { level: "campaign", name, status: "ENABLED", objective: channelType, spend, results: conversions, clicks, impressions, cpa: spend / conversions };
  return {
    id: "aud_net",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType, currency: "USD" } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: { totals: { spend, conversions, currency: "USD" }, platforms: { GOOGLE: { spend, conversions, clicks, impressions, currency: "USD" } } },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: [campaign] }, byDimension: {}, byDay: [] } } },
    },
  };
};

describe("resolveGoogleNetwork", () => {
  it("detects the dominant network from advertisingChannelType (spend-weighted)", () => {
    const ds = {
      data: { platforms: { GOOGLE: { byLevel: { campaign: [
        { level: "campaign", name: "A", objective: "DISPLAY", spend: 8000 },
        { level: "campaign", name: "B", objective: "SEARCH", spend: 2000 },
      ] } } } },
    };
    expect(resolveGoogleNetwork(ds)).toBe("DISPLAY");
  });

  it("maps PERFORMANCE_MAX → PMAX and falls back to a name heuristic", () => {
    const ds = {
      data: { platforms: { GOOGLE: { byLevel: { campaign: [
        { level: "campaign", name: "PMax | Shopping", objective: "PERFORMANCE_MAX", spend: 5000 },
      ] } } } },
    };
    expect(resolveGoogleNetwork(ds)).toBe("PMAX");
    const byName = { data: { platforms: { GOOGLE: { byLevel: { campaign: [
      { level: "campaign", name: "Display | Prospecting", spend: 3000 }, // no objective
    ] } } } } };
    expect(resolveGoogleNetwork(byName)).toBe("DISPLAY");
  });

  it("returns null when no campaigns / no network signal", () => {
    expect(resolveGoogleNetwork({ data: { platforms: { GOOGLE: { byLevel: { campaign: [] } } } } })).toBeNull();
  });
});

describe("getBenchmark network override (Google)", () => {
  it("uses the Display band for a Display account, the Search table for Search", () => {
    expect(getBenchmark("ctr", "GOOGLE", "Lead Gen", "DISPLAY")).toEqual(GOOGLE_NETWORK_BENCHMARKS.DISPLAY.ctr);
    // Search falls through to the (Search-calibrated) business-type table.
    const search = getBenchmark("ctr", "GOOGLE", "Lead Gen", "SEARCH");
    expect(search.good).toBe(6.0);
  });
  it("ignores network for non-Google platforms", () => {
    const meta = getBenchmark("ctr", "META", "eCommerce", "DISPLAY");
    expect(meta.good).toBe(2.2); // Meta table, network ignored
  });
});

describe("BENCH-CTR-001 is network-aware", () => {
  it("does NOT flag a normal-CTR Display account against the Search bar", () => {
    // 0.55% CTR is fine for Display (good 0.6) but far below the Search danger (0.5? no—6% good).
    const { findings } = runDeterministicAudit(googleAccount({ channelType: "DISPLAY", ctrPct: 0.55 }));
    const f = findings.find((x) => x.ruleId === "BENCH-CTR-001");
    // 0.55 is between Display warning(0.35) and good(0.6) → acceptable, not a danger finding.
    expect(f).toBeUndefined();
  });

  it("DOES flag a genuinely dead Display CTR (below the Display danger)", () => {
    const { findings } = runDeterministicAudit(googleAccount({ channelType: "DISPLAY", ctrPct: 0.08 }));
    const f = findings.find((x) => x.ruleId === "BENCH-CTR-001");
    expect(f).toBeDefined();
    expect(f.evidence.network).toBe("DISPLAY");
    expect(f.evidence.advisory).toBe(true); // still advisory — no recoverable
  });

  it("flags a Search account below the Search bar", () => {
    const { findings } = runDeterministicAudit(googleAccount({ channelType: "SEARCH", ctrPct: 0.3 }));
    const f = findings.find((x) => x.ruleId === "BENCH-CTR-001");
    expect(f).toBeDefined();
    expect(f.evidence.network).toBe("SEARCH");
  });
});
