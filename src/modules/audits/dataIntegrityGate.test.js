import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

/**
 * Data-integrity gate. A malformed manual upload can make the numbers physically
 * impossible (clicks > impressions, mismapped columns). Trusting it produced a
 * confident garbage headline — one real upload claimed ~50% of a $2.8M account
 * was recoverable. The gate detects the impossibility and the report refuses to
 * quantify, leading instead with a data-integrity warning.
 */
const account = ({ impressions, clicks, conversions = 50, spend = 90000 }) => ({
  id: "aud_di",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "MANUAL_UPLOAD",
  healthScore: 50,
  categoryScores: { overall: 50 },
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend, conversions, currency: "PKR" },
      platforms: { GOOGLE: { spend, conversions, clicks, impressions, currency: "PKR", uploadedFiles: 1, rowCount: 40 } },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [{ level: "campaign", name: "Burn | PK", spend, conversions: 2, impressions, clicks }],
          byLevel: { campaign: [
            { level: "campaign", name: "Burn | PK", spend: spend * 0.7, conversions: 1, impressions: impressions * 0.5, clicks: clicks * 0.5, cpa: spend * 0.7 },
            { level: "campaign", name: "OK | PK", spend: spend * 0.3, conversions: conversions, impressions: impressions * 0.5, clicks: clicks * 0.5, cpa: (spend * 0.3) / conversions },
          ] },
          byDimension: {},
          byDay: [],
        },
      },
    },
  },
});

describe("data-integrity gate", () => {
  it("fires a CRITICAL finding when clicks exceed impressions", () => {
    const { findings } = runDeterministicAudit(account({ impressions: 3082, clicks: 5558 }));
    const di = findings.find((f) => f.ruleId === "DATA-INTEGRITY-001");
    expect(di).toBeDefined();
    expect(di.severity).toBe("CRITICAL");
    expect(di.evidence.dataIntegrityBroken).toBe(true);
  });

  it("refuses to quantify recoverable when integrity is broken", () => {
    const audit = account({ impressions: 3082, clicks: 5558 });
    const res = runDeterministicAudit(audit);
    audit.ruleFindings = res.findings;
    const doc = buildReportDocumentFromAudit(audit);
    expect(doc.key_numbers.find((k) => /recoverable|leak/i.test(k.label)).value).toMatch(/no quantified/i);
    expect(doc.sections.find((s) => s.id === "money-map")).toBeUndefined();
    expect(doc.executive_summary.projection).toBeUndefined();
    expect(doc.masthead.headline).toMatch(/internally inconsistent/i);
  });

  it("does not fire on a healthy account (clicks ≤ impressions)", () => {
    const { findings } = runDeterministicAudit(account({ impressions: 40000, clicks: 3000 }));
    expect(findings.find((f) => f.ruleId === "DATA-INTEGRITY-001")).toBeUndefined();
  });
});
