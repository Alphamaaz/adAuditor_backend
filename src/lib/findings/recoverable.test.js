import { describe, it, expect } from "vitest";
import { reconcileRecoverable } from "./recoverable.js";

/**
 * The financoach overlap: one broken campaign surfaces as geo + campaign +
 * audience + device findings. Naive summing = PKR 32,141 (37% of spend!). The
 * reconciled total counts the shared dollars once.
 */
const financoachFindings = [
  { ruleId: "GOOGLE-GEO-001", estimatedImpact: "PKR 11,021 is recoverable by excluding Pakistan", evidence: { country: "Pakistan" } },
  { ruleId: "CAMP-CPA-001", estimatedImpact: "PKR 10,391 is recoverable", evidence: { worstEntity: "Display | PK | Signals | Tightened | 6/8" } },
  { ruleId: "GOOGLE-AUD-001", estimatedImpact: "PKR 6,787 of Display | PK spend", evidence: { worstCampaign: "Display | PK | Signals | Tightened | 6/8" } },
  { ruleId: "GOOGLE-DEVICE-001", estimatedImpact: "PKR 234 is recoverable", evidence: { campaign: "Display | PK | Signals | Tightened | 6/8" } },
  { ruleId: "SEG-WASTE-001", estimatedImpact: "PKR 3,491 in this segment is recoverable", evidence: { dimension: "day_of_week", segment: "Thursday" } },
  { ruleId: "GOOGLE-DEVICE-001", estimatedImpact: "PKR 217 is recoverable", evidence: { campaign: "PK Display 6/16" } },
];

describe("reconcileRecoverable", () => {
  it("counts overlapping PK findings once and stays far below the naive sum", () => {
    const naiveSum = 11021 + 10391 + 6787 + 234 + 3491 + 217; // 32,141
    const { total, overlapping } = reconcileRecoverable(financoachFindings, { accountSpend: 86922 });
    // PK pool (geo+campaign+audience+device) → 11,021 once; Thursday 3,491; the
    // separate "PK Display 6/16" device 217 → 14,729.
    expect(total).toBe(11021 + 3491 + 217);
    expect(total).toBeLessThan(naiveSum / 2);
    expect(overlapping).toBe(true);
  });

  it("sums genuinely separate campaigns", () => {
    const findings = [
      { ruleId: "CAMP-CPA-001", estimatedImpact: "$5,000 recoverable", evidence: { worstEntity: "Campaign A" } },
      { ruleId: "CAMP-CPA-001", estimatedImpact: "$3,000 recoverable", evidence: { worstEntity: "Campaign B" } },
    ];
    const { total, overlapping } = reconcileRecoverable(findings, { accountSpend: 100000 });
    expect(total).toBe(8000);
    expect(overlapping).toBe(false);
  });

  it("merges a geo finding into the campaign it targets", () => {
    const findings = [
      { ruleId: "CAMP-CPA-001", estimatedImpact: "PKR 9,000 recoverable", evidence: { worstEntity: "Search | IND | Brand" } },
      { ruleId: "GOOGLE-GEO-001", estimatedImpact: "PKR 9,500 recoverable", evidence: { country: "India" } },
    ];
    const { total } = reconcileRecoverable(findings, { accountSpend: 100000 });
    expect(total).toBe(9500); // max of the merged pool, not 18,500
  });

  it("merges a Meta geo leak into campaign waste even when the campaign isn't named by country", () => {
    // "Kingdom Testing" delivers to GB — no country token in the name, so the
    // geo leak (the same dollars as the campaign waste) must fold in, not add.
    const findings = [
      { ruleId: "CAMP-CPA-001", estimatedImpact: "PKR 2,410 recoverable", evidence: { worstEntity: "Kingdom Testing" } },
      { ruleId: "META-GEO-001", estimatedImpact: "PKR 2,411 recoverable", evidence: { country: "United Kingdom" } },
    ];
    const { total } = reconcileRecoverable(findings, { accountSpend: 12427 });
    expect(total).toBe(2411); // not 4,821
  });

  it("caps the total at the spend backstop", () => {
    const findings = [
      { ruleId: "CAMP-CPA-001", estimatedImpact: "$80,000 recoverable", evidence: { worstEntity: "A" } },
      { ruleId: "CAMP-CPA-001", estimatedImpact: "$70,000 recoverable", evidence: { worstEntity: "B" } },
    ];
    const { total, capped } = reconcileRecoverable(findings, { accountSpend: 100000 });
    expect(total).toBe(60000); // 60% cap
    expect(capped).toBe(true);
  });

  it("pools audience/placement segments with campaign dispersion (report-21 overlap)", () => {
    // Facebook-placement waste + 18-24 age waste are the SAME spend the campaign
    // dispersion already measures, sliced by audience. They must NOT stack — the
    // headline was hitting the 60% cap (PKR 154,617 on 257,696 spend).
    const findings = [
      { ruleId: "CAMP-CPA-001", estimatedImpact: "PKR 120,977 is recoverable", evidence: { worstEntity: "Alt Testing phase 2 | new cr" } },
      { ruleId: "SEG-WASTE-001", estimatedImpact: "PKR 88,033 in this segment is recoverable", evidence: { dimension: "placement", segment: "facebook" } },
      { ruleId: "SEG-WASTE-001", estimatedImpact: "PKR 34,685 in this segment is recoverable", evidence: { dimension: "age", segment: "18-24" } },
    ];
    const { total, capped } = reconcileRecoverable(findings, { accountSpend: 257696 });
    expect(total).toBe(120977); // max(campaign 120,977, placement 88,033) — not summed
    expect(capped).toBe(false); // no longer slamming into the 60% cap
  });

  it("still adds a temporal lever (day-of-week) on top of audience pools", () => {
    const findings = [
      { ruleId: "CAMP-CPA-001", estimatedImpact: "PKR 50,000 recoverable", evidence: { worstEntity: "A" } },
      { ruleId: "SEG-WASTE-001", estimatedImpact: "PKR 40,000 recoverable", evidence: { dimension: "placement", segment: "facebook" } },
      { ruleId: "SEG-WASTE-001", estimatedImpact: "PKR 9,000 recoverable", evidence: { dimension: "day_of_week", segment: "Thursday" } },
    ];
    const { total } = reconcileRecoverable(findings, { accountSpend: 500000 });
    // max(campaign 50k, placement 40k) = 50k, + Thursday 9k (distinct lever) = 59k.
    expect(total).toBe(59000);
  });

  it("returns 0 for no quantified findings", () => {
    const { total } = reconcileRecoverable([{ ruleId: "OPP-001", estimatedImpact: "Brand risk" }], { accountSpend: 5000 });
    expect(total).toBe(0);
  });
});
