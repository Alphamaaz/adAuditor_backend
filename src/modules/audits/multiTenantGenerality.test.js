import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * Multi-tenant generality + isolation.
 *
 * The new insights (winners-paused allocation, geo bleed, audience fragmentation,
 * dead-campaign hygiene, target-CPA inference) must be ACCOUNT-AGNOSTIC: they fire
 * on the PATTERN, in any account, with any campaign names/countries — never tied
 * to the one account they were first observed on. These fixtures deliberately use
 * entirely different markets, names, currencies, and structures than the original
 * (no "PK 6/16", no Pakistan, no segment 2488…). Each is audited independently to
 * prove tenant isolation: one account's data never leaks into another's findings.
 */

const googleTenant = ({ id, currency, campaigns, byLevelExtra = {}, targetCpa = null }) => {
  const spend = campaigns.reduce((s, c) => s + (c.spend || 0), 0);
  const conversions = campaigns.reduce((s, c) => s + (c.conversions || 0), 0);
  const clicks = campaigns.reduce((s, c) => s + (c.clicks || 0), 0);
  return {
    id,
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    healthScore: 60,
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency, targetCpa } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend, conversions, currency },
        platforms: { GOOGLE: { spend, conversions, clicks, impressions: clicks * 12, currency, uploadedFiles: 1, rowCount: 30 } },
      },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns, ...byLevelExtra }, byDimension: {}, byDay: [] } } },
    },
  };
};

// ── Tenant A: a US e-commerce account, winners paused (USD) ───────────────────
const tenantA = () =>
  googleTenant({
    id: "tenant-A-ecom-us",
    currency: "USD",
    campaigns: [
      { level: "campaign", name: "Holiday Blowout", status: "ENABLED", spend: 8000, conversions: 40, clicks: 3200, cpa: 200 },
      { level: "campaign", name: "Evergreen Brand", status: "PAUSED", spend: 9000, conversions: 300, clicks: 6000, cpa: 30 },
      { level: "campaign", name: "Prospecting Q3", status: "PAUSED", spend: 6000, conversions: 150, clicks: 4000, cpa: 40 },
    ],
  });

// ── Tenant B: a UK lead-gen account bleeding into Germany (GBP) ───────────────
const tenantB = () =>
  googleTenant({
    id: "tenant-B-leadgen-uk",
    currency: "GBP",
    campaigns: [
      { level: "campaign", name: "UK | Search | Core", status: "ENABLED", spend: 12000, conversions: 240, clicks: 6000, cpa: 50 },
    ],
    byLevelExtra: {
      geo: [
        { level: "geo", campaignName: "UK | Search | Core", country: "United Kingdom", spend: 11000, clicks: 5500, conversions: 240 },
        { level: "geo", campaignName: "UK | Search | Core", country: "Germany", spend: 1000, clicks: 500, conversions: 0 },
      ],
    },
  });

// ── Tenant C: a healthy account — NOTHING structural should fire ─────────────
const tenantC = () =>
  googleTenant({
    id: "tenant-C-healthy",
    currency: "EUR",
    targetCpa: 45,
    campaigns: [
      { level: "campaign", name: "Brand DE", status: "ENABLED", spend: 10000, conversions: 250, clicks: 5000, cpa: 40 },
      { level: "campaign", name: "Generic DE", status: "ENABLED", spend: 8000, conversions: 180, clicks: 4000, cpa: 44 },
    ],
  });

// ── Tenant D: an AU account with audience fragmentation (AUD) ─────────────────
const tenantD = () =>
  googleTenant({
    id: "tenant-D-frag-au",
    currency: "AUD",
    campaigns: [
      { level: "campaign", name: "AU | Display | Prospecting", status: "ENABLED", spend: 9000, conversions: 120, clicks: 4500, cpa: 75 },
    ],
    byLevelExtra: {
      audience_performance: Array.from({ length: 7 }, (_, i) => ({
        level: "audience_performance", adGroupId: "AG-AU-1", adGroupName: "Ad group 1", campaignName: "AU | Display | Prospecting",
        criterionId: `aud-${i}`, spend: 1300, clicks: 600, conversions: i < 2 ? 30 : 0,
      })),
    },
  });

const has = (findings, ruleId) => findings.some((f) => f.ruleId === ruleId);

describe("multi-tenant generality", () => {
  it("winners-paused (ALLOC) fires for ANY account with the pattern — different names/currency", () => {
    const { findings } = runDeterministicAudit(tenantA());
    const f = findings.find((x) => x.ruleId === "GOOGLE-ALLOC-001");
    expect(f).toBeDefined();
    expect(f.evidence.liveCampaign).toBe("Holiday Blowout"); // detected dynamically, not hard-coded
    expect(f.evidence.pausedWinner).toBe("Evergreen Brand");
  });

  it("geo bleed (GEO-002) fires for ANY country pair — UK→Germany, not just one market", () => {
    const { findings } = runDeterministicAudit(tenantB());
    const f = findings.find((x) => x.ruleId === "GOOGLE-GEO-002");
    expect(f).toBeDefined();
    expect(f.evidence.homeCountry).toBe("United Kingdom");
    expect(f.evidence.country).toBe("Germany");
  });

  it("audience fragmentation (FRAG) fires for ANY account's crammed ad group", () => {
    const { findings } = runDeterministicAudit(tenantD());
    expect(has(findings, "GOOGLE-FRAG-001")).toBe(true);
  });

  it("a HEALTHY account triggers none of the structural insights (no false positives)", () => {
    const { findings } = runDeterministicAudit(tenantC());
    for (const rule of ["GOOGLE-ALLOC-001", "GOOGLE-GEO-002", "GOOGLE-FRAG-001", "GOOGLE-HYGIENE-001"]) {
      expect(has(findings, rule)).toBe(false);
    }
  });

  it("tenant isolation: auditing one account does not change another's findings", () => {
    // Run interleaved; each result must depend ONLY on its own dataset.
    const a1 = runDeterministicAudit(tenantA()).findings.map((f) => f.ruleId).sort();
    const b1 = runDeterministicAudit(tenantB()).findings.map((f) => f.ruleId).sort();
    const a2 = runDeterministicAudit(tenantA()).findings.map((f) => f.ruleId).sort();
    const b2 = runDeterministicAudit(tenantB()).findings.map((f) => f.ruleId).sort();
    expect(a2).toEqual(a1); // A is stable regardless of B running between
    expect(b2).toEqual(b1);
    // And the two tenants produce genuinely different finding sets.
    expect(a1).not.toEqual(b1);
    // A's allocation insight must not appear on B, and B's geo bleed not on A.
    expect(a1).toContain("GOOGLE-ALLOC-001");
    expect(a1).not.toContain("GOOGLE-GEO-002");
    expect(b1).toContain("GOOGLE-GEO-002");
    expect(b1).not.toContain("GOOGLE-ALLOC-001");
  });
});
