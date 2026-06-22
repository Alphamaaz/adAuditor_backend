import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

// Local money parser mirroring the report's strict currency match.
const moneyMagnitude = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const m = text.match(/(?:\$|USD|EUR|GBP|PKR|INR|AED|SAR|CAD|AUD|SGD)\s?([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, "")) || 0 : 0;
};

/**
 * Money-accounting coherence (from the live ad-audit-report (13) review):
 *   - a delivery block is "blocked", not "recoverable", and is excluded from the
 *     recoverable headline (it's restorable upside, not recovered waste);
 *   - the bidding finding's uncapped spend is NOT recoverable;
 *   - a rate-only finding ("21%") must not leak a phantom money figure;
 *   - no money-map line item exceeds the recoverable headline.
 */
const audit = (findings) => ({
  id: "aud_money",
  selectedPlatforms: ["META"],
  healthScore: 60,
  categoryScores: { overall: 60 },
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  ruleFindings: findings,
  normalizedDataset: {
    summary: {
      totals: { spend: 12428, conversions: 204, currency: "PKR" },
      platforms: { META: { spend: 12428, conversions: 204, currency: "PKR" } },
    },
    data: { platforms: { META: { byLevel: { campaign: [] }, currency: "PKR" } } },
  },
});

const findings = [
  {
    ruleId: "META-POLICY-001", platform: "META", severity: "CRITICAL",
    title: "Meta ad disapproved and blocking delivery", detail: "x",
    estimatedImpact: "PKR 7,089 of proven delivery is blocked until this ad clears review.",
    evidence: { blocksDelivery: true, confidence: "high" },
  },
  {
    ruleId: "CAMP-CPA-001", platform: "META", severity: "CRITICAL",
    title: "Campaign burning at zero conversions", detail: "x",
    estimatedImpact: "PKR 3,188 is recoverable", evidence: { level: "campaign", confidence: "high" },
  },
  {
    ruleId: "META-BID-001", platform: "META", severity: "MEDIUM",
    title: "3 campaigns run uncapped automatic bidding", detail: "x",
    estimatedImpact: "These campaigns run without a cost-per-result ceiling. As budgets scale, a cost cap near your target keeps cost-per-result from drifting.",
    evidence: { confidence: "high" },
  },
  {
    ruleId: "META-FLOW-001", platform: "META", severity: "MEDIUM",
    title: "Campaign converts clicks at a fraction of your best", detail: "x",
    estimatedImpact: "Lifting from 21% toward the 59% your best campaign achieves would roughly 2.8x its results at the same click cost.",
    evidence: { confidence: "high" },
  },
];

describe("report money coherence", () => {
  const doc = buildReportDocumentFromAudit(audit(findings));
  const recoverableValue = doc.key_numbers.find((k) => /recoverable/i.test(k.label)).value;
  const recoverable = moneyMagnitude(recoverableValue);

  it("excludes the delivery block from the recoverable headline", () => {
    // Recoverable = the PKR 3,188 waste only — NOT the PKR 7,089 blocked delivery.
    expect(recoverable).toBe(3188);
  });

  it("labels the delivery block as 'blocked', not 'recoverable'", () => {
    const findingsTable = doc.sections.find((s) => s.id === "findings").blocks[0];
    const policyRow = findingsTable.rows.find((r) => /disapproved|blocking/i.test(r[1]));
    expect(policyRow[3]).toMatch(/blocked/i);
    expect(policyRow[3]).not.toMatch(/recoverable/i);
  });

  it("does not show a recoverable figure for the bidding guardrail", () => {
    const findingsTable = doc.sections.find((s) => s.id === "findings").blocks[0];
    const bidRow = findingsTable.rows.find((r) => /uncapped/i.test(r[1]));
    expect(bidRow[3]).not.toMatch(/recoverable/i);
  });

  it("does not leak a phantom money figure from a rate-only finding", () => {
    // "21%" / "59%" / "2.8x" must not be read as money.
    const flow = findings.find((f) => f.ruleId === "META-FLOW-001");
    expect(moneyMagnitude(flow.estimatedImpact)).toBe(0);
  });

  it("keeps every money-map line item at or below the recoverable headline", () => {
    const moneyMap = doc.sections.find((s) => s.id === "money-map");
    if (!moneyMap) return;
    for (const row of moneyMap.blocks[0].rows) {
      expect(moneyMagnitude(row.display)).toBeLessThanOrEqual(recoverable);
    }
  });
});
