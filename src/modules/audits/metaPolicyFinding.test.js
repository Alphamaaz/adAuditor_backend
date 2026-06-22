import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { byLeverageDesc } from "../../lib/findings/priority.js";

/**
 * META-POLICY-001 — the issue the engine was completely blind to. effective_status
 * was fetched but never surfaced, so a DISAPPROVED ad gating most of the
 * account's delivery went unreported and Creative Performance scored 100/100.
 */
const baseAudit = (ads) => ({
  id: "aud_policy",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 12427, conversions: 183, currency: "PKR" },
      platforms: { META: { spend: 12427, conversions: 183, clicks: 411, impressions: 39578, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 12427, results: 183 }, ...ads],
          byLevel: {
            campaign: [{ level: "campaign", name: "C1", spend: 12427, results: 183 }],
            ad: ads,
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("META-POLICY-001", () => {
  it("fires CRITICAL for a disapproved ad that drove most of the account's results", () => {
    const { findings } = runDeterministicAudit(
      baseAudit([
        { level: "ad", name: "New Engagement Ad", campaignName: "New Engagement Campaign", status: "DISAPPROVED", spend: 7089, results: 161, reviewFeedback: "Personal Attributes" },
        { level: "ad", name: "New Leads Ad", campaignName: "Pesh | WA | 23/5", status: "WITH_ISSUES", spend: 2928, results: 22 },
      ])
    );
    const policy = findings.filter((f) => f.ruleId === "META-POLICY-001");
    const disapproved = policy.find((f) => f.evidence.status === "DISAPPROVED");
    expect(disapproved).toBeDefined();
    expect(disapproved.severity).toBe("CRITICAL");
    expect(disapproved.category).toBe("Creative Performance");
    expect(disapproved.evidence.resultSharePercent).toBeGreaterThan(80);
    expect(disapproved.rootCause).toMatch(/compliance block/i);
    expect(disapproved.evidence.policyReason).toBe("Personal Attributes");

    const withIssues = policy.find((f) => f.evidence.status === "WITH_ISSUES");
    expect(withIssues.severity).toBe("HIGH");
  });

  it("ranks the disapproved compliance block as the #1 finding (leverage)", () => {
    const { findings } = runDeterministicAudit(
      baseAudit([
        { level: "ad", name: "New Engagement Ad", campaignName: "New Engagement Campaign", status: "DISAPPROVED", spend: 7089, results: 161 },
      ])
    );
    // Consumers (report, evidence packet) sort by leverage; a delivery block
    // must lead even though other CRITICALs (e.g. the CPM benchmark) carry more
    // raw dollars.
    const ranked = [...findings].sort(byLeverageDesc);
    expect(ranked[0].ruleId).toBe("META-POLICY-001");
  });

  it("drops Creative Performance below 100 when an ad is disapproved", () => {
    const { scores } = runDeterministicAudit(
      baseAudit([
        { level: "ad", name: "New Engagement Ad", campaignName: "New Engagement Campaign", status: "DISAPPROVED", spend: 7089, results: 161 },
      ])
    );
    expect(scores.platforms.META.categories["Creative Performance"]).toBeLessThan(100);
  });

  it("does not fire for a disapproved ad that never spent (hygiene, not a block)", () => {
    const { findings } = runDeterministicAudit(
      baseAudit([
        { level: "ad", name: "Dead Ad", campaignName: "C1", status: "DISAPPROVED", spend: 0, results: 0 },
      ])
    );
    expect(findings.find((f) => f.ruleId === "META-POLICY-001")).toBeUndefined();
  });

  it("does not fire when all ads are approved/active", () => {
    const { findings } = runDeterministicAudit(
      baseAudit([
        { level: "ad", name: "Good Ad", campaignName: "C1", status: "ACTIVE", spend: 5000, results: 100 },
      ])
    );
    expect(findings.find((f) => f.ruleId === "META-POLICY-001")).toBeUndefined();
  });
});
