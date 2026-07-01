import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

/**
 * Coherence fixes found by reviewing two freshly-run live reports:
 *   1. Funnel: an unrealistic declared target (below every campaign's achieved
 *      CPA) branded EVERY campaign — including the proven winner — "downstream",
 *      contradicting the lead ("re-enable this winner"). Measure against the
 *      achievable floor instead.
 *   2. Meta dead-campaign hygiene listed a campaign as "no delivery" when a
 *      same-named shell existed in the structure-only bucket AND the real campaign
 *      spent — so it appeared as both converting (funnel) and dead (hygiene).
 *   3. A "counted above" (net-0) finding's takeaway scraped a CPA from its text
 *      and claimed "recover PKR 61" — money it doesn't recover.
 */

// ── 1. Funnel effective-target ────────────────────────────────────────────────
const googleFunnelAudit = (targetCpa) => {
  const campaigns = [
    { level: "campaign", name: "Winner", status: "PAUSED", spend: 8400, results: 100, clicks: 2870, cpa: 84 },   // CPA 84, CVR 3.48%
    { level: "campaign", name: "Live Loser", status: "ENABLED", spend: 19000, results: 55, clicks: 7400, cpa: 345 }, // CPA 345, CVR 0.74%
  ];
  const spend = 27400, conversions = 155, clicks = 10270;
  const a = {
    id: "aud_funnel", selectedPlatforms: ["GOOGLE"], dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: { totals: { spend, conversions, currency: "PKR" }, platforms: { GOOGLE: { spend, conversions, clicks, impressions: clicks * 15, currency: "PKR" } } },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns }, byDimension: {}, byDay: [] } } },
    },
  };
  const res = runDeterministicAudit(a);
  a.ruleFindings = res.findings;
  return buildReportDocumentFromAudit(a);
};

describe("funnel uses an achievable effective target", () => {
  it("does NOT brand the proven winner 'downstream' when the target is unrealistically low", () => {
    // Target 40 is below the best achieved CPA (84) — the classic unrealistic target.
    const funnel = googleFunnelAudit(40).sections.find((s) => s.id === "funnel-cvr");
    const winner = funnel.blocks[0].rows.find((r) => r[0] === "Winner");
    const loser = funnel.blocks[0].rows.find((r) => r[0] === "Live Loser");
    expect(winner[4]).not.toMatch(/downstream/i); // winner reads "Funnel converts"
    expect(loser[4]).toMatch(/downstream/i); // the genuinely-broken one still flagged
    expect(funnel.intro).toMatch(/achievable/i); // discloses the override
  });

  it("uses the declared target directly when it IS realistic", () => {
    const funnel = googleFunnelAudit(90).sections.find((s) => s.id === "funnel-cvr");
    expect(funnel.intro).not.toMatch(/achievable/i); // no override needed
  });

  it("excludes tiny-sample campaigns and CPC-above-target rows (no 830%-CVR noise)", () => {
    const campaigns = [
      { level: "campaign", name: "Main", status: "ENABLED", spend: 8000, results: 200, clicks: 4000, cpa: 40 }, // 4000 clicks, converts
      { level: "campaign", name: "Tiny Test", status: "PAUSED", spend: 749, results: 5, clicks: 8, cpa: 149 },   // 8 clicks — noise
      { level: "campaign", name: "High CPC", status: "PAUSED", spend: 1661, results: 1, clicks: 60, cpa: 1661 }, // CPC 27.7 > target 40? no; make CPC high
    ];
    // Force High CPC's CPC above target: spend 4000 / 60 clicks = 66.7 CPC > 40 target.
    campaigns[2].spend = 4000;
    const spend = campaigns.reduce((s, c) => s + c.spend, 0);
    const a = {
      id: "aud_funnel_gate", selectedPlatforms: ["GOOGLE"], dataSource: "OAUTH",
      businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 40 } },
      intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
      uploadReadiness: { mode: "FULL" },
      normalizedDataset: {
        summary: { totals: { spend, conversions: 206, currency: "PKR" }, platforms: { GOOGLE: { spend, conversions: 206, clicks: 4068, impressions: 60000, currency: "PKR" } } },
        data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns }, byDimension: {}, byDay: [] } } },
      },
    };
    const res = runDeterministicAudit(a);
    a.ruleFindings = res.findings;
    const funnel = buildReportDocumentFromAudit(a).sections.find((s) => s.id === "funnel-cvr");
    const names = funnel.blocks[0].rows.map((r) => r[0]);
    expect(names).toContain("Main");
    expect(names).not.toContain("Tiny Test"); // <50 clicks → excluded
    expect(names).not.toContain("High CPC"); // required CVR > 100% → excluded
    // No row can show a required CVR above 100%.
    for (const r of funnel.blocks[0].rows) expect(parseFloat(r[2])).toBeLessThanOrEqual(100);
  });
});

// ── 2. Meta dead-campaign excludes a live-named shell ─────────────────────────
describe("Meta dead-campaign hygiene excludes shells that share a live campaign's name", () => {
  it("does not list a spending campaign as 'no delivery'", () => {
    const audit = {
      id: "aud_meta_hyg", selectedPlatforms: ["META"], dataSource: "OAUTH",
      businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
      intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
      uploadReadiness: { mode: "FULL" },
      normalizedDataset: {
        summary: { totals: { spend: 7000, conversions: 180, currency: "PKR" }, platforms: { META: { spend: 7000, conversions: 180, clicks: 800, impressions: 20000, currency: "PKR" } } },
        data: { platforms: { META: { records: [], byLevel: {
          campaign: [{ level: "campaign", name: "Live Camp", status: "PAUSED", spend: 7000, results: 180, clicks: 800, impressions: 20000 }],
          adset: [{ level: "adset", name: "AS1", campaignName: "Live Camp", spend: 7000, impressions: 20000, clicks: 800, results: 180 }],
          campaignStructureOnly: [
            { level: "campaignStructureOnly", name: "Live Camp", status: "PAUSED", spend: 0, impressions: 0, clicks: 0 }, // shell, same name as live
            { level: "campaignStructureOnly", name: "Dead A", status: "PAUSED", spend: 0, impressions: 0, clicks: 0 },
            { level: "campaignStructureOnly", name: "Dead B", status: "PAUSED", spend: 0, impressions: 0, clicks: 0 },
          ],
        }, byDimension: {}, byDay: [] } } },
      },
    };
    const { findings } = runDeterministicAudit(audit);
    const hyg = findings.find((f) => f.ruleId === "META-HYGIENE-002");
    expect(hyg).toBeDefined();
    expect(hyg.evidence.deadCampaignCount).toBe(2); // Dead A + Dead B, NOT "Live Camp"
    expect(hyg.evidence.examples).not.toContain("Live Camp");
  });
});

// ── 3. Counted-above findings never claim a recovery takeaway ──────────────────
describe("net-0 findings never render a recovery takeaway", () => {
  it("no finding card claims 'recover X' when its reconciled net is 0", () => {
    // The 384-style account: dispersion + audience/device counted-above findings.
    const campaigns = [
      { level: "campaign", name: "PK Live", status: "ENABLED", spend: 19000, results: 55, clicks: 7400, cpa: 345 },
      { level: "campaign", name: "BD Winner", status: "PAUSED", spend: 31000, results: 370, clicks: 10000, cpa: 84 },
    ];
    const audit = {
      id: "aud_net0", selectedPlatforms: ["GOOGLE"], dataSource: "OAUTH",
      businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
      intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
      uploadReadiness: { mode: "FULL" },
      normalizedDataset: {
        summary: { totals: { spend: 50000, conversions: 425, currency: "PKR" }, platforms: { GOOGLE: { spend: 50000, conversions: 425, clicks: 17400, impressions: 300000, currency: "PKR" } } },
        data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns,
          device: [{ level: "device", campaignName: "PK Live", device: "Desktop", spend: 600, clicks: 250, conversions: 0 }],
        }, byDimension: {}, byDay: [] } } },
      },
    };
    const res = runDeterministicAudit(audit);
    audit.ruleFindings = res.findings;
    const doc = buildReportDocumentFromAudit(audit);
    const netById = new Map(res.findings.map((f) => [f.title, f.evidence?.netRecoverable]));
    const evid = (doc.sections || []).find((s) => s.id === "finding-detail");
    for (const card of evid?.blocks || []) {
      const takeaway = (card.body_blocks || []).find((b) => b.type === "takeaway");
      const net = netById.get(card.headline);
      if (takeaway && /recover/i.test(takeaway.text)) {
        // A recovery takeaway is only allowed when the finding actually nets > 0.
        expect(net, `takeaway on net-0 card "${card.headline}"`).toBeGreaterThan(0);
      }
    }
  });
});
