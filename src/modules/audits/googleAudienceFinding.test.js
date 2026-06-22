import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildEvidencePacket } from "./evidencePacket.service.js";

/**
 * GOOGLE-AUD-001 — the flagship "mis-applied audience" finding from the
 * competitor-parity comparison. The same audience segment (criterion id
 * 2488177887755) runs at a healthy CPA in the BD campaign but collapses in PK —
 * a BD-trained audience applied to a different market. This is the single
 * finding the competing audit was proudest of and ours could not produce.
 */
const audienceFor = (perf) => ({
  id: "aud_google_audience",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 42802, conversions: 351 },
      platforms: {
        GOOGLE: { spend: 42802, conversions: 351, clicks: 15089, impressions: 433215, currency: "PKR" },
      },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [{ level: "campaign", name: "Display | BD | Signals", spend: 17560 }],
          byLevel: {
            campaign: [
              { level: "campaign", name: "Display | BD | Signals", status: "ACTIVE", bidStrategy: "TARGET_CPA", spend: 17560, results: 211, clicks: 6649 },
            ],
            audience_performance: perf,
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

const seg = (criterionId, campaignName, spend, conversions, clicks) => ({
  level: "audience_performance",
  criterionId,
  audienceType: "USER_LIST",
  audienceLabel: `USER_LIST #${criterionId}`,
  campaignName,
  spend,
  conversions,
  clicks,
  cpa: conversions > 0 ? spend / conversions : null,
});

describe("GOOGLE-AUD-001 — mis-applied audience (divergence)", () => {
  it("fires CRITICAL when one segment is healthy in BD but broken in PK", () => {
    const perf = [
      seg("2488177887755", "Display | BD | Signals", 17560, 211, 6649), // CPA ~83
      seg("2488177887755", "Display | IND | Signals", 15492, 132, 5581), // CPA ~117
      seg("2488177887755", "Display | PK | Signals", 7665, 7, 2000), // CPA ~1095
    ];
    const { findings } = runDeterministicAudit(audienceFor(perf));
    const aud = findings.find((f) => f.ruleId === "GOOGLE-AUD-001");
    expect(aud).toBeDefined();
    expect(aud.severity).toBe("CRITICAL");
    expect(aud.evidence.criterionId).toBe("2488177887755");
    expect(aud.evidence.bestCampaign).toContain("BD");
    expect(aud.evidence.worstCampaign).toContain("PK");
    expect(aud.evidence.multipleVsBest).toBeGreaterThanOrEqual(10);
    expect(aud.evidence.perCampaign).toHaveLength(3);
    expect(aud.detail).toContain("BD");
    expect(aud.detail).toContain("PK");
    expect(aud.estimatedImpact).toMatch(/^PKR /);
  });

  it("leads the evidence packet (CRITICAL root cause)", () => {
    const perf = [
      seg("2488177887755", "Display | BD | Signals", 17560, 211, 6649),
      seg("2488177887755", "Display | PK | Signals", 7665, 7, 2000),
    ];
    const audit = audienceFor(perf);
    const { findings } = runDeterministicAudit(audit);
    const packet = buildEvidencePacket({ ...audit, ruleFindings: findings });
    expect(packet.topFindings[0].ruleId).toBe("GOOGLE-AUD-001");
  });
});

describe("GOOGLE-AUD-001 — single catastrophic audience (fallback)", () => {
  it("fires HIGH for one audience burning material spend far above baseline", () => {
    // Only one campaign per segment → no divergence; one segment is catastrophic.
    const perf = [
      seg("1111", "Display | BD | Signals", 12000, 145, 5000), // ~83 CPA, healthy
      seg("9999", "Display | BD | Signals", 5000, 4, 1200), // ~1250 CPA, ~10x baseline
    ];
    const { findings } = runDeterministicAudit(audienceFor(perf));
    const aud = findings.find((f) => f.ruleId === "GOOGLE-AUD-001");
    expect(aud).toBeDefined();
    expect(aud.severity).toBe("HIGH");
    expect(aud.evidence.audienceSegment).toBe("USER_LIST #9999");
    expect(aud.evidence.multipleOfBaseline).toBeGreaterThanOrEqual(3);
  });

  it("does NOT fire without audience data", () => {
    const { findings } = runDeterministicAudit(audienceFor([]));
    expect(findings.find((f) => f.ruleId === "GOOGLE-AUD-001")).toBeUndefined();
  });
});
