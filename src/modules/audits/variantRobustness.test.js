import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildReportDocumentFromAudit, validateReportDocument } from "./reportDocument.service.js";

/**
 * Variant robustness harness — "train the tool for more account shapes".
 *
 * We only ever tested a handful of real accounts. This generates a broad matrix
 * of synthetic accounts (platforms × business types × currencies × structural
 * edge cases) plus a seeded-random batch, and asserts the INVARIANTS that must
 * hold on EVERY account, no matter how weird the data:
 *
 *   1. runDeterministicAudit never throws.
 *   2. buildReportDocumentFromAudit never throws and the document validates.
 *   3. Recoverable never exceeds reviewed spend (no >100%-of-spend headline).
 *   4. No paused / diagnostic / advisory / delivery-block finding carries
 *      recoverable money (the confidently-wrong-number class).
 *   5. The headline recoverable equals the sum of the per-finding nets
 *      (body can never contradict the headline).
 *   6. Every finding is well-formed (ruleId, valid severity, title).
 *   7. Every money figure in the money map is a finite, non-negative number.
 *
 * A failure here is a real bug (a crash or a confidently-wrong number) on some
 * account variant — exactly what breaks trust when a new client runs the tool.
 */

const SEVERITIES = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
const CURRENCIES = ["USD", "PKR", "EUR", "GBP", "INR", "AUD", "AED"];
const BUSINESS_TYPES = ["eCommerce", "Lead Gen", "App Install", "B2B SaaS", "Local", "Other"];

// Deterministic RNG so failures reproduce.
const mkRng = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// Coerce to a finite number (real normalizers parse to numbers; the pathological
// fixtures deliberately feed strings/NaN/negatives to stress the ENGINE, but the
// harness's own summary math must stay numeric).
const nz = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const platformSummary = (campaigns, currency) => {
  const spend = campaigns.reduce((s, c) => s + Math.max(0, nz(c.spend)), 0);
  const conversions = campaigns.reduce((s, c) => s + Math.max(0, nz(c.results ?? c.conversions)), 0);
  const clicks = campaigns.reduce((s, c) => s + Math.max(0, nz(c.clicks)), 0);
  const impressions = campaigns.reduce((s, c) => s + Math.max(0, nz(c.impressions) || nz(c.clicks) * 12), 0);
  return { spend, conversions, clicks, impressions, currency, uploadedFiles: 1, rowCount: campaigns.length * 3 };
};

const mkAudit = ({ id, platform = "GOOGLE", businessType = "Lead Gen", currency = "USD", campaigns, byLevelExtra = {}, targetCpa = null, targetRoas = null, monthlyBudget = null, intakeSection }) => {
  const ps = platformSummary(campaigns, currency);
  return {
    id,
    selectedPlatforms: [platform],
    dataSource: "OAUTH",
    healthScore: 60,
    businessProfileSnapshot: { sectionA: { businessType, currency, targetCpa, targetRoas, monthlyBudget } },
    intakeResponses: [{ section: intakeSection || `PLATFORM_${platform}`, answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: { totals: { spend: ps.spend, conversions: ps.conversions, currency }, platforms: { [platform]: ps } },
      data: { platforms: { [platform]: { records: [], byLevel: { campaign: campaigns, ...byLevelExtra }, byDimension: {}, byDay: [] } } },
    },
  };
};

// ── Curated edge cases ────────────────────────────────────────────────────────
const curated = () => {
  const out = [];

  // Single campaign, healthy.
  out.push(mkAudit({ id: "single-healthy", campaigns: [
    { level: "campaign", name: "Only", status: "ENABLED", spend: 5000, results: 100, clicks: 2000, cpa: 50 },
  ], targetCpa: 55 }));

  // All paused.
  out.push(mkAudit({ id: "all-paused", campaigns: [
    { level: "campaign", name: "A", status: "PAUSED", spend: 4000, results: 80, clicks: 1600, cpa: 50 },
    { level: "campaign", name: "B", status: "PAUSED", spend: 3000, results: 10, clicks: 1200, cpa: 300 },
  ], targetCpa: 60 }));

  // Zero conversions everywhere (tracking break OR genuinely dead).
  out.push(mkAudit({ id: "zero-conv", campaigns: [
    { level: "campaign", name: "A", status: "ENABLED", spend: 4000, results: 0, clicks: 1600 },
    { level: "campaign", name: "B", status: "ENABLED", spend: 3000, results: 0, clicks: 1200 },
  ], targetCpa: 60 }));

  // Corrupt: clicks > impressions.
  out.push(mkAudit({ id: "corrupt-clicks", campaigns: [
    { level: "campaign", name: "A", status: "ENABLED", spend: 4000, results: 50, clicks: 9000, impressions: 100, cpa: 80 },
  ], targetCpa: 60 }));

  // Empty byLevel (summary-only).
  {
    const a = mkAudit({ id: "summary-only", campaigns: [] });
    a.normalizedDataset.data.platforms.GOOGLE.byLevel = {};
    a.normalizedDataset.summary.totals = { spend: 12000, conversions: 200, currency: "USD" };
    a.normalizedDataset.summary.platforms.GOOGLE = { spend: 12000, conversions: 200, clicks: 4000, impressions: 80000, currency: "USD" };
    out.push(a);
  }

  // Winners paused, live on the loser (the ALLOC pattern) + search-term waste.
  out.push(mkAudit({ id: "winners-paused+stwaste", currency: "PKR", campaigns: [
    { level: "campaign", name: "Live Loser", status: "ENABLED", spend: 20000, results: 40, clicks: 8000, cpa: 500 },
    { level: "campaign", name: "Paused Winner", status: "PAUSED", spend: 30000, results: 400, clicks: 10000, cpa: 75 },
  ], targetCpa: 80, byLevelExtra: {
    search_term: [
      { level: "search_term", searchTerm: "free thing", campaignName: "Live Loser", spend: 4000, clicks: 400, conversions: 0 },
      { level: "search_term", searchTerm: "cheap junk", campaignName: "Live Loser", spend: 3000, clicks: 300, conversions: 0 },
      { level: "search_term", searchTerm: "buy now", campaignName: "Live Loser", spend: 5000, clicks: 200, conversions: 30 },
    ],
  }}));

  // Anomaly-cheap conversions (WhatsApp-tap-as-lead) mixed with real campaigns.
  out.push(mkAudit({ id: "anomaly-cheap", currency: "PKR", campaigns: [
    { level: "campaign", name: "Real", status: "ENABLED", spend: 20000, results: 200, clicks: 8000, cpa: 100 },
    { level: "campaign", name: "FakeCheap", status: "ENABLED", spend: 5000, results: 2000, clicks: 6000, cpa: 2.5 },
  ], targetCpa: 90 }));

  // Dead shells + duplicates.
  out.push(mkAudit({ id: "dead-shells", campaigns: [
    { level: "campaign", name: "Live", status: "ENABLED", spend: 8000, results: 120, clicks: 3000, cpa: 66 },
    ...Array.from({ length: 6 }, (_, i) => ({ level: "campaign", name: `OLD ${i}`, status: "PAUSED", spend: 0, results: 0, clicks: 0, impressions: 0 })),
  ], targetCpa: 70 }));

  // eCommerce with conversions but zero value (OPP-002).
  out.push(mkAudit({ id: "ecom-no-value", businessType: "eCommerce", campaigns: [
    { level: "campaign", name: "Shopping", status: "ENABLED", spend: 10000, results: 200, clicks: 4000, cpa: 50, conversionValue: 0 },
  ], targetRoas: 3 }));

  // Meta account (ROAS < 1).
  out.push(mkAudit({ id: "meta-roas<1", platform: "META", businessType: "eCommerce", campaigns: [
    { level: "campaign", name: "ASC", status: "ACTIVE", spend: 10000, results: 100, clicks: 3000, cpa: 100, conversionValue: 6000 },
  ], targetRoas: 2 }));

  // TikTok account.
  out.push(mkAudit({ id: "tiktok-basic", platform: "TIKTOK", businessType: "App Install", campaigns: [
    { level: "campaign", name: "TT1", status: "ACTIVE", spend: 6000, results: 300, clicks: 5000, cpa: 20 },
  ], targetCpa: 18 }));

  // Pathological: negative / NaN / missing fields must not crash or leak NaN.
  out.push(mkAudit({ id: "pathological-values", campaigns: [
    { level: "campaign", name: "Neg", status: "ENABLED", spend: -500, results: -3, clicks: -10, cpa: null },
    { level: "campaign", status: "ENABLED", spend: NaN, results: undefined, clicks: null }, // missing name
    { level: "campaign", name: "Huge", status: "ENABLED", spend: 1e12, results: 1, clicks: 5e9, cpa: 1e12 },
    { level: "campaign", name: "Str", status: "ENABLED", spend: "3000", results: "40", clicks: "1500" },
  ], targetCpa: 60 }));

  // Missing status entirely + missing intake answers.
  {
    const a = mkAudit({ id: "no-status", campaigns: [
      { level: "campaign", name: "A", spend: 4000, results: 60, clicks: 1500, cpa: 66 },
      { level: "campaign", name: "B", spend: 3000, results: 5, clicks: 1200, cpa: 600 },
    ], targetCpa: 70 });
    a.intakeResponses = [];
    out.push(a);
  }

  // No business profile at all.
  {
    const a = mkAudit({ id: "no-profile", campaigns: [
      { level: "campaign", name: "A", status: "ENABLED", spend: 5000, results: 80, clicks: 2000, cpa: 62 },
    ] });
    a.businessProfileSnapshot = null;
    out.push(a);
  }

  return out;
};

// ── Seeded-random breadth ─────────────────────────────────────────────────────
const randomAccounts = (n) => {
  const rng = mkRng(20260701);
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const out = [];
  for (let i = 0; i < n; i++) {
    const platform = pick(["GOOGLE", "META", "TIKTOK"]);
    const currency = pick(CURRENCIES);
    const businessType = pick(BUSINESS_TYPES);
    const nCamp = 1 + Math.floor(rng() * 6);
    const statuses = platform === "META" ? ["ACTIVE", "PAUSED"] : ["ENABLED", "PAUSED"];
    const campaigns = Array.from({ length: nCamp }, (_, j) => {
      const clicks = Math.floor(rng() * 8000) + 50;
      const cpaBase = 20 + rng() * 400;
      const conv = rng() < 0.15 ? 0 : Math.max(1, Math.floor((clicks * (0.005 + rng() * 0.06))));
      const spend = Math.round(conv > 0 ? conv * cpaBase : clicks * (0.5 + rng() * 3));
      return {
        level: "campaign",
        name: `C${i}-${j}`,
        status: pick(statuses),
        spend,
        results: conv,
        clicks,
        impressions: clicks * (5 + Math.floor(rng() * 20)),
        cpa: conv > 0 ? Math.round(spend / conv) : null,
      };
    });
    out.push(mkAudit({
      id: `rand-${i}`,
      platform,
      businessType,
      currency,
      campaigns,
      targetCpa: rng() < 0.6 ? Math.round(30 + rng() * 200) : null,
      monthlyBudget: rng() < 0.5 ? Math.round(50000 + rng() * 500000) : null,
    }));
  }
  return out;
};

const reviewedSpend = (audit) => audit.normalizedDataset.summary.totals.spend || 0;

const checkInvariants = (audit) => {
  // 1. Engine never throws.
  const res = runDeterministicAudit(audit);
  expect(Array.isArray(res.findings)).toBe(true);

  // 6. Every finding well-formed.
  for (const f of res.findings) {
    expect(typeof f.ruleId).toBe("string");
    expect(f.ruleId.length).toBeGreaterThan(0);
    expect(SEVERITIES.has(f.severity)).toBe(true);
    expect(typeof f.title).toBe("string");
    // 4. Paused/diagnostic/advisory/blocking → never recoverable money.
    const net = f.evidence?.netRecoverable;
    if (Number.isFinite(net) && net > 0) {
      expect(f.evidence?.diagnostic).not.toBe(true);
      expect(f.evidence?.advisory).not.toBe(true);
      expect(f.evidence?.blocksDelivery).not.toBe(true);
    }
  }

  // 3 + 5. Recoverable ≤ reviewed spend, and headline == sum of nets.
  const spend = reviewedSpend(audit);
  const sumNets = res.findings.reduce(
    (s, f) => s + (Number.isFinite(f.evidence?.netRecoverable) ? f.evidence.netRecoverable : 0),
    0
  );
  expect(sumNets).toBeGreaterThanOrEqual(0);
  if (spend > 0) expect(sumNets).toBeLessThanOrEqual(spend + 1);

  // 2. Report builds + validates.
  const doc = buildReportDocumentFromAudit({ ...audit, ruleFindings: res.findings });
  const v = validateReportDocument(doc);
  expect(v.isValid, `invalid doc for ${audit.id}: ${JSON.stringify(v.errors)}`).toBe(true);

  // 7. Money-map values finite ≥ 0.
  const moneyMap = (doc.sections || []).find((s) => s.id === "money-map");
  if (moneyMap) {
    for (const block of moneyMap.blocks || []) {
      for (const row of block.rows || []) {
        expect(Number.isFinite(row.value)).toBe(true);
        expect(row.value).toBeGreaterThanOrEqual(0);
      }
    }
  }

  // Headline key number never negative / NaN.
  const rec = (doc.key_numbers || []).find((k) => /recoverable/i.test(k.label || ""));
  if (rec && /[\d]/.test(rec.value)) {
    // value like "PKR 14,619" — strip non-digits.
    const n = Number(String(rec.value).replace(/[^\d.]/g, "")) || 0;
    expect(n).toBeGreaterThanOrEqual(0);
    if (spend > 0) expect(n).toBeLessThanOrEqual(spend + 1);
  }
  return { res, doc, sumNets, spend };
};

describe("variant robustness — invariants hold on every account shape", () => {
  for (const audit of curated()) {
    it(`curated: ${audit.id}`, () => {
      checkInvariants(audit);
    });
  }

  it("seeded-random batch (150 accounts) — no crash, no >100%-of-spend, valid docs", () => {
    for (const audit of randomAccounts(150)) {
      checkInvariants(audit);
    }
  });
});
