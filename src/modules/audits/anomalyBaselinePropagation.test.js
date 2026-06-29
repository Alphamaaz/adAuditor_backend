import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";

// A lead-gen account with a WhatsApp tracking anomaly (cheap button taps counted
// as leads). The blended baseline collapses to ~PKR 53, but the genuine baseline
// is ~PKR 115. This locks in that the anomaly-quarantined baseline propagates to
// segment- and ad-set-level findings, instead of the contradiction where the
// headline says PKR 115 but a segment finding says PKR 53.
const campaigns = [
  { level: "campaign", name: "LP Leads A", status: "ACTIVE", resultFamily: "lead", spend: 114000, results: 1020, impressions: 211000, clicks: 8100, cpa: 112 },
  { level: "campaign", name: "LP Leads B", status: "ACTIVE", resultFamily: "lead", spend: 56000, results: 410, impressions: 64000, clicks: 2600, cpa: 137 },
  { level: "campaign", name: "LP Leads C", status: "ACTIVE", resultFamily: "lead", spend: 52000, results: 507, impressions: 162000, clicks: 6300, cpa: 103 },
  { level: "campaign", name: "WhatsApp Chats", status: "ACTIVE", resultFamily: "lead", spend: 42000, results: 3200, impressions: 56000, clicks: 14000, cpa: 13 },
];
// Ad sets: each campaign has a broad + interest set. The WhatsApp campaign's ad
// sets carry the same cheap CPA; their campaignName links to the anomaly campaign.
const adsets = [
  { level: "adset", name: "broad", campaignName: "LP Leads A", resultFamily: "lead", spend: 69000, results: 637, cpa: 108 },
  { level: "adset", name: "interest", campaignName: "LP Leads A", resultFamily: "lead", spend: 45000, results: 383, cpa: 117 },
  { level: "adset", name: "broad", campaignName: "LP Leads B", resultFamily: "lead", spend: 33000, results: 240, cpa: 137 },
  { level: "adset", name: "interest", campaignName: "LP Leads B", resultFamily: "lead", spend: 23000, results: 170, cpa: 135 },
  { level: "adset", name: "broad", campaignName: "LP Leads C", resultFamily: "lead", spend: 38000, results: 350, cpa: 108 },
  { level: "adset", name: "interest", campaignName: "LP Leads C", resultFamily: "lead", spend: 14000, results: 157, cpa: 89 },
  { level: "adset", name: "wa-broad", campaignName: "WhatsApp Chats", resultFamily: "lead", spend: 28000, results: 2100, cpa: 13 },
  { level: "adset", name: "wa-interest", campaignName: "WhatsApp Chats", resultFamily: "lead", spend: 14000, results: 1100, cpa: 13 },
];

const audit = () => ({
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", targetCpa: 40 } },
  intakeResponses: [],
  normalizedDataset: {
    data: {
      platforms: {
        META: {
          byLevel: { campaign: campaigns, adset: adsets },
          records: [...campaigns, ...adsets],
          byDimension: {
            placement: [
              { segment: "facebook", spend: 172000, impressions: 348000, clicks: 8400, results: 1500 }, // CPA ~115
              { segment: "audience_network", spend: 42000, impressions: 56000, clicks: 14000, results: 3200 }, // the anomaly
            ],
          },
        },
      },
    },
    summary: {
      platforms: { META: { spend: 264000, conversions: 5137, impressions: 493000, clicks: 17000, currency: "PKR" } },
      totals: { spend: 264000, conversions: 5137, currency: "PKR" },
    },
  },
});

const findings = () => runDeterministicAudit(audit()).findings;

describe("anomaly baseline propagation", () => {
  it("fires the tracking anomaly and computes a trusted baseline well above the blended one", () => {
    const anomaly = findings().find((f) => f.ruleId === "TRACK-ANOMALY-001");
    expect(anomaly).toBeTruthy();
    expect(anomaly.evidence.trustedBaselineCpa).toBeGreaterThan(100);
    expect(anomaly.evidence.reportedBaselineCpa).toBeLessThan(60);
  });

  it("judges every segment against the trusted baseline, not the poisoned PKR 53", () => {
    const seg = findings().filter((f) => f.ruleId === "SEG-WASTE-001");
    // No segment finding may use the collapsed blended baseline.
    for (const f of seg) expect(f.evidence.baselineCpa).toBeGreaterThan(100);
    // Facebook (CPA ~115 ≈ the true baseline) is no longer a material false
    // positive: against PKR 53 it claimed ~PKR 94k excess; against ~115 it's
    // negligible and never critical/high.
    const fb = seg.find((f) => /facebook/i.test(f.evidence?.segment || ""));
    if (fb) {
      expect(["MEDIUM", "LOW"]).toContain(fb.severity);
      expect(fb.evidence.netRecoverable || 0).toBeLessThan(5000);
    }
  });

  it("does not produce a phantom ad-set recoverable from the poisoned baseline", () => {
    // Excluding the cheap WhatsApp ad sets, the genuine ad sets (89–137) don't
    // disperse ≥1.5× the ~115 baseline → no inflated dispersion finding.
    const adset = findings().find((f) => f.ruleId === "META-ADSET-001");
    if (adset) {
      expect(adset.evidence.baselineCpa).toBeGreaterThan(100);
      expect(adset.evidence.worstEntity).not.toMatch(/wa-/);
    }
  });

  it("reports CPA-over-target against the trusted CPA, not the blended phantom", () => {
    const diag = findings().find((f) => f.ruleId === "DIAG-CPA-001");
    if (diag) expect(diag.evidence.actualCpa).toBeGreaterThan(100);
  });

  it("suppresses CTR/CPM efficiency findings while the anomaly contaminates engagement", () => {
    // The fake clicks inflate CTR in the segments that would set the "best"
    // benchmark, so an "exclude this segment" call would be harmful. We make none
    // until tracking is fixed.
    expect(findings().some((f) => f.ruleId === "META-EFF-001")).toBe(false);
  });

  it("does not flag a core segment as inefficient off a contaminated benchmark", () => {
    // No segment-engagement exclusion advice is emitted at all under anomaly.
    const harmful = findings().filter(
      (f) => /buys impressions inefficiently/i.test(f.title)
    );
    expect(harmful).toHaveLength(0);
  });
});
