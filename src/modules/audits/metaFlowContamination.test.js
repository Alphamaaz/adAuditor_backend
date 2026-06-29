import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * META-FLOW-001 (click-to-result divergence) must not fire off a contaminated
 * yardstick. Three ways it used to mislead:
 *  1. A tracking-anomaly campaign (WhatsApp button-tap counted as a result) has a
 *     near-1:1 click-to-result rate. Left in, it becomes the "best" benchmark and
 *     every healthy campaign looks like it "converts at a fraction of your best."
 *  2. A messaging campaign converts click→conversation far higher than a lead
 *     campaign converts click→form-fill. Comparing across families is a
 *     destination mismatch, not a funnel problem.
 *  3. A handful of conversions is too small a sample to claim a rate gap.
 */

const baseAudit = (campaigns) => ({
  id: "aud_flow",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", lookbackDays: 30 } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 0, conversions: 0, currency: "PKR" },
      platforms: {
        META: {
          spend: campaigns.reduce((s, c) => s + c.spend, 0),
          conversions: campaigns.reduce((s, c) => s + c.results, 0),
          currency: "PKR",
          // The anomaly detector populates this; emulate a flagged WhatsApp campaign.
          anomaly: {
            entityNames: new Set(["whatsapp button taps"]),
            trustedBaselineCpa: 115,
          },
        },
      },
    },
    data: {
      platforms: {
        META: {
          records: campaigns,
          byLevel: { campaign: campaigns, adset: [] },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

const flow = (findings) => findings.find((f) => f.ruleId === "META-FLOW-001");

describe("META-FLOW-001 contamination guards", () => {
  it("does not benchmark healthy lead campaigns against a fake-conversion campaign", () => {
    const campaigns = [
      // Anomaly: 980 'results' from 1000 link clicks → 98% rate. Would be 'best'.
      { level: "campaign", name: "WhatsApp Button Taps", resultFamily: "messaging", spend: 14000, results: 980, linkClicks: 1000 },
      // Two genuine lead campaigns converting click→form at normal rates.
      { level: "campaign", name: "LP Leads A", resultFamily: "lead", spend: 60000, results: 300, linkClicks: 1500 }, // 20%
      { level: "campaign", name: "LP Leads B", resultFamily: "lead", spend: 50000, results: 120, linkClicks: 1400 }, // 8.5%
    ];
    const { findings } = runDeterministicAudit(baseAudit(campaigns));
    const f = flow(findings);
    // If it fires, it must NOT name the anomaly campaign as the benchmark.
    if (f) {
      expect(f.evidence.benchmarkCampaign).not.toBe("WhatsApp Button Taps");
      expect(f.evidence.campaign).not.toBe("WhatsApp Button Taps");
    }
  });

  it("does not compare a lead campaign against a messaging campaign", () => {
    const campaigns = [
      // Messaging campaign (genuine, not anomaly) with a high click→conversation rate.
      { level: "campaign", name: "Messaging Prospecting", resultFamily: "messaging", spend: 40000, results: 400, linkClicks: 800 }, // 50%
      // Lead campaign at a normal, lower click→form rate.
      { level: "campaign", name: "LP Leads A", resultFamily: "lead", spend: 60000, results: 150, linkClicks: 1500 }, // 10%
    ];
    const { findings } = runDeterministicAudit(baseAudit(campaigns));
    // Different families → no cross-family "worse than" finding.
    expect(flow(findings)).toBeUndefined();
  });

  it("does not flag a campaign with too few conversions to judge a rate", () => {
    const campaigns = [
      { level: "campaign", name: "LP Leads A", resultFamily: "lead", spend: 60000, results: 300, linkClicks: 1500 }, // 20%
      // Same family, low rate, but only 8 conversions — too small to claim a gap.
      { level: "campaign", name: "Tiny Lead Test", resultFamily: "lead", spend: 4000, results: 8, linkClicks: 800 }, // 1%
    ];
    const { findings } = runDeterministicAudit(baseAudit(campaigns));
    expect(flow(findings)).toBeUndefined();
  });

  it("still fires for a genuine same-family funnel gap with adequate sample", () => {
    const campaigns = [
      { level: "campaign", name: "LP Leads A", resultFamily: "lead", spend: 60000, results: 300, linkClicks: 1500 }, // 20%
      { level: "campaign", name: "LP Leads Weak", resultFamily: "lead", spend: 50000, results: 70, linkClicks: 1400 }, // 5% (<= half)
    ];
    const { findings } = runDeterministicAudit(baseAudit(campaigns));
    const f = flow(findings);
    expect(f).toBeDefined();
    expect(f.evidence.campaign).toBe("LP Leads Weak");
    expect(f.evidence.benchmarkCampaign).toBe("LP Leads A");
  });
});
