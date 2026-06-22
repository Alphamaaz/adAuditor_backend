import { describe, it, expect } from "vitest";
import { collapseOverlappingFindings } from "./dedupe.js";

/**
 * The Farooq LD duplicate: a campaign and the lone ad set inside it both report
 * the same PKR 1,661 zero-conversion waste. They are one issue, not two.
 */
describe("collapseOverlappingFindings", () => {
  it("collapses a campaign + its ad set reporting the same money, keeping the campaign", () => {
    const findings = [
      {
        ruleId: "CAMP-CPA-001",
        platform: "META",
        severity: "CRITICAL",
        estimatedImpact: "PKR 1,661 is recoverable",
        evidence: { level: "campaign", worstEntity: "Kingdom Testing" },
      },
      {
        ruleId: "META-ADSET-001",
        platform: "META",
        severity: "CRITICAL",
        estimatedImpact: "PKR 1,661 is recoverable",
        evidence: { level: "adset", worstEntity: "New Leads Ad Set" },
      },
    ];
    const out = collapseOverlappingFindings(findings);
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("CAMP-CPA-001"); // campaign is more actionable
  });

  it("collapses overlapping dispersion even when the amounts differ (ad-set pass swept more)", () => {
    // Campaign (PKR 3,188) and ad-set (PKR 9,303) describe the same overlapping
    // spend hierarchy on one platform → keep the campaign-level finding.
    const findings = [
      { ruleId: "CAMP-CPA-001", platform: "META", severity: "CRITICAL", estimatedImpact: "PKR 3,188 recoverable", evidence: { level: "campaign", confidence: "high" } },
      { ruleId: "META-ADSET-001", platform: "META", severity: "CRITICAL", estimatedImpact: "PKR 9,303 recoverable", evidence: { level: "adset", confidence: "medium" } },
    ];
    const out = collapseOverlappingFindings(findings);
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("CAMP-CPA-001");
  });

  it("keeps dispersion findings on different platforms (they don't overlap)", () => {
    const findings = [
      { ruleId: "CAMP-CPA-001", platform: "META", severity: "HIGH", estimatedImpact: "$9,000 recoverable", evidence: { level: "campaign" } },
      { ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "HIGH", estimatedImpact: "$3,000 recoverable", evidence: { level: "campaign" } },
    ];
    expect(collapseOverlappingFindings(findings)).toHaveLength(2);
  });

  it("does not touch non-dispersion findings that share an amount", () => {
    const findings = [
      { ruleId: "SEG-WASTE-001", severity: "HIGH", estimatedImpact: "PKR 500 recoverable" },
      { ruleId: "BENCH-CPM-001", severity: "HIGH", estimatedImpact: "PKR 500 recoverable" },
    ];
    expect(collapseOverlappingFindings(findings)).toHaveLength(2);
  });

  it("preserves order and leaves unrelated findings in place", () => {
    const findings = [
      { ruleId: "META-CAPI", severity: "HIGH", estimatedImpact: "Risk" },
      { ruleId: "CAMP-CPA-001", severity: "CRITICAL", estimatedImpact: "PKR 1,661 recoverable", evidence: { level: "campaign" } },
      { ruleId: "META-ADSET-001", severity: "CRITICAL", estimatedImpact: "PKR 1,661 recoverable", evidence: { level: "adset" } },
      { ruleId: "OPP-001", severity: "MEDIUM", estimatedImpact: "Brand gap" },
    ];
    const out = collapseOverlappingFindings(findings);
    expect(out.map((f) => f.ruleId)).toEqual(["META-CAPI", "CAMP-CPA-001", "OPP-001"]);
  });

  it("returns the same array when nothing overlaps", () => {
    const findings = [
      { ruleId: "CAMP-CPA-001", severity: "HIGH", estimatedImpact: "$1,000 recoverable", evidence: { level: "campaign" } },
    ];
    expect(collapseOverlappingFindings(findings)).toBe(findings);
  });
});

describe("collapseOverlappingFindings — geo folded into its campaign", () => {
  it("drops a geo finding whose country names the over-baseline campaign, keeping ONE money line", () => {
    // financoach: GOOGLE-GEO Pakistan and CAMP-CPA 'Display | PK …' are the same
    // PKR 11,931 spend pool described twice.
    const findings = [
      {
        ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "CRITICAL",
        title: "Google CPA varies sharply by campaign",
        detail: "Display | PK | Signals | Tightened | 6/8 runs 8.9x the baseline.",
        estimatedImpact: "PKR 11,931 is recoverable by bringing these campaigns toward baseline.",
        fixSteps: ["Isolate Display | PK and diagnose its CPA driver."],
        evidence: { level: "campaign", worstEntity: "Display | PK | Signals | Tightened | 6/8" },
      },
      {
        ruleId: "GOOGLE-GEO-001", platform: "GOOGLE", severity: "HIGH",
        title: "Pakistan runs at PKR 536 CPA",
        detail: "Pakistan runs well above baseline.",
        estimatedImpact: "PKR 11,931 is recoverable by excluding Pakistan.",
        fixSteps: ['Set targeting to "Presence", not "Presence or interest".'],
        evidence: { country: "Pakistan" },
      },
    ];
    const out = collapseOverlappingFindings(findings);
    expect(out).toHaveLength(1);
    expect(out[0].ruleId).toBe("CAMP-CPA-001");
    // Geo insight preserved on the kept campaign finding.
    expect(out[0].evidence.geoCauseFolded).toBe("Pakistan");
    expect(out[0].evidence.geoCauseFoldedFrom).toBe("GOOGLE-GEO-001");
    expect(out[0].detail).toMatch(/Pakistan/);
    expect(out[0].rootCause).toMatch(/geographic leak to Pakistan/i);
    // Location fix carried over.
    expect(out[0].fixSteps.some((s) => /presence|location/i.test(s))).toBe(true);
  });

  it("keeps a geo finding that does not match any campaign name (multi-campaign leak)", () => {
    const findings = [
      {
        ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "CRITICAL",
        estimatedImpact: "PKR 11,931 recoverable",
        evidence: { level: "campaign", worstEntity: "Display | PK | Signals" },
      },
      {
        ruleId: "GOOGLE-GEO-001", platform: "GOOGLE", severity: "HIGH",
        estimatedImpact: "PKR 4,000 recoverable",
        evidence: { country: "Germany" }, // no token in any campaign name
      },
    ];
    const out = collapseOverlappingFindings(findings);
    expect(out).toHaveLength(2);
  });

  it("leaves a geo finding alone when there is no campaign-dispersion finding", () => {
    const findings = [
      { ruleId: "GOOGLE-GEO-001", platform: "GOOGLE", severity: "HIGH", estimatedImpact: "PKR 4,000 recoverable", evidence: { country: "Pakistan" } },
    ];
    expect(collapseOverlappingFindings(findings)).toBe(findings);
  });
});
