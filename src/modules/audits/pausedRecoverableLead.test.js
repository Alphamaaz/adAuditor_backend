import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { byLeverageDesc } from "../../lib/findings/priority.js";

/**
 * Regression for the client-reported defect on account 384-565-5841: our report
 * LED with a paused campaign's historical CPA dispersion and booked its spend as
 * "recoverable" (a number the client could never act on), while the real lever —
 * the account is live on its worst campaign while proven winners sit paused —
 * was buried. The expert (Claude-MCP) audit led with the reallocation.
 *
 * After the fix:
 *   - GOOGLE-ALLOC-001 (winners-paused) LEADS by leverage, carrying the
 *     reallocation recoverable.
 *   - A paused campaign contributes 0 recoverable to the dispersion finding.
 *   - The same live-campaign spend is counted ONCE (ALLOC carries it, the
 *     dispersion nets to 0), never stacked.
 */
const account = () => {
  const campaigns = [
    // The only LIVE campaign — and the worst performer.
    { level: "campaign", name: "PK - Display - 6/16", status: "ENABLED", bidStrategy: "TARGET_CPA", spend: 19323, results: 56, clicks: 7540, cpa: 345 },
    // Proven paused winners.
    { level: "campaign", name: "BD | Signals | 6/6", status: "PAUSED", bidStrategy: "TARGET_CPA", spend: 31920, results: 380, clicks: 10932, cpa: 84 },
    { level: "campaign", name: "IND | Signals | 6/7 #2", status: "PAUSED", bidStrategy: "TARGET_CPA", spend: 7584, results: 79, clicks: 2849, cpa: 96 },
    // A paused LOSER running ~9x baseline — must NOT become recoverable or lead.
    { level: "campaign", name: "PK | Signals | 6/8", status: "PAUSED", bidStrategy: "MAXIMIZE_CONVERSIONS", spend: 9864, results: 8, clicks: 3867, cpa: 1233 },
  ];
  const spend = campaigns.reduce((s, c) => s + c.spend, 0);
  const conversions = campaigns.reduce((s, c) => s + c.results, 0);
  const clicks = campaigns.reduce((s, c) => s + c.clicks, 0);
  return {
    id: "aud_paused_lead",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: {
        totals: { spend, conversions, currency: "PKR" },
        platforms: { GOOGLE: { spend, conversions, clicks, impressions: clicks * 12, currency: "PKR", uploadedFiles: 1, rowCount: 40 } },
      },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns }, byDimension: {}, byDay: [] } } },
    },
  };
};

describe("winners-paused leads; paused waste is not recoverable", () => {
  it("GOOGLE-ALLOC-001 leads the report by leverage (not the dispersion finding)", () => {
    const { findings } = runDeterministicAudit(account());
    const leader = [...findings].sort(byLeverageDesc)[0];
    expect(leader.ruleId).toBe("GOOGLE-ALLOC-001");
    expect(leader.evidence.liveCampaign).toBe("PK - Display - 6/16");
    expect(leader.evidence.pausedWinner).toBe("BD | Signals | 6/6");
  });

  it("the reallocation recoverable is positive and based on the LIVE spend", () => {
    const { findings } = runDeterministicAudit(account());
    const alloc = findings.find((f) => f.ruleId === "GOOGLE-ALLOC-001");
    // 19,323 live spend * (1 - 84/345) ≈ 14,619 — the reallocation gap.
    expect(alloc.evidence.netRecoverable).toBeGreaterThan(10000);
    expect(alloc.evidence.netRecoverable).toBeLessThan(19323); // never exceeds the live spend
  });

  it("the paused 9x-baseline campaign is NOT the dispersion headline and carries no recoverable", () => {
    const { findings } = runDeterministicAudit(account());
    const disp = findings.find((f) => f.ruleId === "CAMP-CPA-001");
    expect(disp).toBeDefined();
    // Headline campaign is the LIVE one a reader can act on, not the paused loser.
    expect(disp.evidence.worstEntity).toBe("PK - Display - 6/16");
    expect(disp.evidence.worstPaused).toBe(false);
    // The same live pool is counted once — ALLOC carries it, dispersion nets to 0.
    expect(disp.evidence.netRecoverable).toBe(0);
  });

  it("does not book the paused PK | 6/8 spend (PKR 9,864) as recoverable anywhere", () => {
    const { findings } = runDeterministicAudit(account());
    const totalNet = findings.reduce(
      (s, f) => s + (Number.isFinite(f.evidence?.netRecoverable) ? f.evidence.netRecoverable : 0),
      0
    );
    // Headline stays anchored to the live reallocation (~14.6k), nowhere near the
    // old inflated figure that swept in the paused campaign's ~20k history.
    expect(totalNet).toBeLessThan(18000);
  });
});
