import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildEvidencePacket } from "./evidencePacket.service.js";

/**
 * Minimal audit with Meta byDimension data containing a wasteful age segment.
 * Proves SEG-WASTE-001 fires in the production engine and flows into the
 * evidence packet that the AI consumes.
 */
const auditWithSegments = () => ({
  id: "aud_seg",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  businessProfileSnapshot: { sectionA: { businessType: "eCommerce" } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 1510, conversions: 47 },
      platforms: {
        META: { spend: 1510, conversions: 47, clicks: 1080, impressions: 100000, currency: "PKR" },
      },
    },
    data: {
      platforms: {
        META: {
          records: [{ level: "campaign", name: "C1", spend: 1510 }],
          byLevel: { campaign: [{ level: "campaign", name: "C1", spend: 1510, results: 47 }] },
          byDimension: {
            age: [
              { dimension: "age", segment: "18-24", spend: 575, clicks: 400, conversions: 21 },
              { dimension: "age", segment: "25-34", spend: 729, clicks: 500, conversions: 25 },
              { dimension: "age", segment: "45-54", spend: 206, clicks: 180, conversions: 0 },
            ],
          },
          byDay: [],
        },
      },
    },
  },
});

describe("SEG-WASTE-001 (production engine)", () => {
  it("fires for the wasteful age segment with rich evidence", () => {
    const { findings } = runDeterministicAudit(auditWithSegments());
    const seg = findings.find((f) => f.ruleId === "SEG-WASTE-001");
    expect(seg).toBeDefined();
    expect(seg.platform).toBe("META");
    expect(seg.evidence.dimension).toBe("age");
    expect(seg.evidence.segment).toBe("45-54");
    expect(seg.evidence.estimatedWaste).toBe(206);
    expect(seg.evidence.segmentCpa).toBeNull(); // zero conversions
    expect(seg.evidence.baselineCpa).toBeGreaterThan(0);
    expect(seg.evidence.reason).toBe("zero_conversions");
  });

  it("does NOT fire when there is no byDimension data (CSV-only safety)", () => {
    const audit = auditWithSegments();
    audit.normalizedDataset.data.platforms.META.byDimension = {};
    const { findings } = runDeterministicAudit(audit);
    expect(findings.find((f) => f.ruleId === "SEG-WASTE-001")).toBeUndefined();
  });

  it("surfaces the segment finding's dollars in the evidence packet", () => {
    const audit = auditWithSegments();
    const { findings } = runDeterministicAudit(audit);
    const packet = buildEvidencePacket({ ...audit, ruleFindings: findings });
    const segInPacket = packet.topFindings.find((f) => f.ruleId === "SEG-WASTE-001");
    expect(segInPacket).toBeDefined();
    expect(packet.verifiedNumbers).toContain(206);
  });
});
