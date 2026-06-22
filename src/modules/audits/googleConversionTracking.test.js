import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

/**
 * GOOGLE-CONV-001 — conversion-tracking health. Every CPA/ROAS number and every
 * Smart Bidding decision is only as good as the conversion setup. Fires the most
 * severe issue found and stays silent when tracking is healthy. No conversion-
 * action config (best-effort fetch skipped) → no finding, never a false positive.
 */
const convAudit = (conversionActions, summary = { spend: 50000, conversions: 400, clicks: 18000, impressions: 600000, currency: "PKR" }) => ({
  id: "aud_conv",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: summary.spend, conversions: summary.conversions },
      platforms: { GOOGLE: summary },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [{ level: "campaign", name: "C", spend: summary.spend, results: summary.conversions }],
          byLevel: {
            campaign: [{ level: "campaign", name: "C", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: summary.spend, results: summary.conversions, clicks: summary.clicks }],
            conversion_action: conversionActions,
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

const find = (findings) => findings.find((f) => f.ruleId === "GOOGLE-CONV-001");

describe("GOOGLE-CONV-001 — conversion-tracking health", () => {
  it("CRITICAL: no active conversion tracking at all", () => {
    const { findings } = runDeterministicAudit(
      convAudit([{ level: "conversion_action", name: "Old Purchase", status: "PAUSED", category: "PURCHASE", primaryForGoal: false }])
    );
    const f = find(findings);
    expect(f).toBeDefined();
    expect(f.severity).toBe("CRITICAL");
    expect(f.evidence.enabledConversionActions).toBe(0);
    expect(f.title).toMatch(/no active conversion tracking/i);
  });

  it("CRITICAL: actions configured but zero conversions recorded on material spend", () => {
    const { findings } = runDeterministicAudit(
      convAudit(
        [{ level: "conversion_action", name: "Lead", status: "ACTIVE", category: "LEAD", primaryForGoal: true }],
        { spend: 50000, conversions: 0, clicks: 18000, impressions: 600000, currency: "PKR" }
      )
    );
    const f = find(findings);
    expect(f).toBeDefined();
    expect(f.severity).toBe("CRITICAL");
    expect(f.evidence.accountConversions).toBe(0);
    expect(f.title).toMatch(/zero conversions recorded/i);
  });

  it("HIGH: conversions tracked but none marked primary", () => {
    const { findings } = runDeterministicAudit(
      convAudit([
        { level: "conversion_action", name: "Purchase", status: "ACTIVE", category: "PURCHASE", primaryForGoal: false },
        { level: "conversion_action", name: "Add to cart", status: "ACTIVE", category: "ADD_TO_CART", primaryForGoal: false },
      ])
    );
    const f = find(findings);
    expect(f).toBeDefined();
    expect(f.severity).toBe("HIGH");
    expect(f.evidence.primaryConversionActions).toBe(0);
    expect(f.title).toMatch(/none are set as primary/i);
  });

  it("MEDIUM: primary conversions only measure page views", () => {
    const { findings } = runDeterministicAudit(
      convAudit([
        { level: "conversion_action", name: "Landing visit", status: "ACTIVE", category: "PAGE_VIEW", primaryForGoal: true },
      ])
    );
    const f = find(findings);
    expect(f).toBeDefined();
    expect(f.severity).toBe("MEDIUM");
    expect(f.evidence.primaryCategories).toContain("PAGE_VIEW");
  });

  it("stays silent when tracking is healthy", () => {
    const { findings } = runDeterministicAudit(
      convAudit([
        { level: "conversion_action", name: "Purchase", status: "ACTIVE", category: "PURCHASE", primaryForGoal: true },
        { level: "conversion_action", name: "Page view", status: "ACTIVE", category: "PAGE_VIEW", primaryForGoal: false },
      ])
    );
    expect(find(findings)).toBeUndefined();
  });

  it("stays silent when no conversion-action config was pulled", () => {
    const { findings } = runDeterministicAudit(convAudit([]));
    expect(find(findings)).toBeUndefined();
  });
});
