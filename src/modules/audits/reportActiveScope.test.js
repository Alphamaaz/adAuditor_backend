import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

const campaign = (name, status, spend, results) => ({
  level: "campaign",
  name,
  status,
  spend,
  results,
  impressions: spend * 4,
  clicks: spend,
  cpa: results > 0 ? spend / results : null,
  resultFamily: "lead",
});

const makeAudit = (campaigns) => {
  const total = campaigns.reduce(
    (a, c) => {
      a.spend += c.spend;
      a.conversions += c.results;
      a.impressions += c.impressions;
      a.clicks += c.clicks;
      return a;
    },
    { spend: 0, conversions: 0, impressions: 0, clicks: 0, currency: "PKR" }
  );
  return {
    selectedPlatforms: ["META"],
    healthScore: 70,
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen" } },
    ruleFindings: [
      { ruleId: "X-1", platform: "META", severity: "HIGH", category: "Audience Strategy", title: "Something", detail: "d", estimatedImpact: "PKR 1,000 recoverable", fixSteps: ["fix"], evidence: {} },
    ],
    normalizedDataset: {
      data: { platforms: { META: { byLevel: { campaign: campaigns }, records: campaigns } } },
      summary: { platforms: { META: { ...total } }, totals: { ...total } },
    },
  };
};

const scopeNote = (doc) => doc.method_notes.find((n) => n.label === "Scope")?.text;
const keyNum = (doc, label) => doc.key_numbers.find((k) => k.label === label)?.value;

const breakdownRows = (doc) =>
  doc.sections.find((s) => s.id === "scope-breakdown")?.blocks[0].rows;

describe("active vs paused scope in the report", () => {
  it("shows the total and splits it active vs paused, comparing the active set", () => {
    const doc = makeAudit([
      campaign("Active A", "ACTIVE", 10000, 100),
      campaign("Active B", "ACTIVE", 8000, 80),
      campaign("Active C", "ACTIVE", 6000, 60),
      campaign("Paused D", "PAUSED", 2000, 5),
    ]);
    const built = buildReportDocumentFromAudit(doc);

    // Headline = TOTAL (all 26,000 spend), not active-only.
    expect(keyNum(built, "Spend reviewed")).toBeTruthy();

    // Breakdown table: Active / Paused / Total rows.
    const rows = breakdownRows(built);
    expect(rows.map((r) => r[0])).toEqual(["Active", "Paused", "Total"]);
    expect(rows[0][1]).toBe(24000); // active spend
    expect(rows[1][1]).toBe(2000); // paused spend
    expect(rows[2][1]).toBe(26000); // total spend
    expect(rows[0][3]).toBe("3"); // active count
    expect(rows[1][3]).toBe("1"); // paused count

    expect(scopeNote(built)).toMatch(/3 active/);
    expect(scopeNote(built)).toMatch(/1 paused/);

    // Comparison covers the active set only; paused disclosed separately.
    const dd = built.sections.find((s) => s.id === "campaign-deep-dive");
    expect(dd.title).toBe("Every active campaign, compared");
    const names = dd.blocks[0].rows.map((r) => r[0]);
    expect(names).toHaveLength(3);
    expect(names).not.toContain("Paused D");
  });

  it("renders no breakdown/scope note when there are no paused campaigns", () => {
    const doc = makeAudit([
      campaign("Active A", "ACTIVE", 10000, 100),
      campaign("Active B", "ACTIVE", 8000, 80),
    ]);
    const built = buildReportDocumentFromAudit(doc);
    expect(breakdownRows(built)).toBeUndefined();
    expect(scopeNote(built)).toBeUndefined();
  });

  it("does not blank an all-paused account; notes the scope instead", () => {
    const doc = makeAudit([
      campaign("Paused A", "PAUSED", 5000, 50),
      campaign("Paused B", "PAUSED", 4000, 40),
    ]);
    const built = buildReportDocumentFromAudit(doc);
    expect(breakdownRows(built)).toBeUndefined(); // no active cohort to split against
    expect(scopeNote(built)).toMatch(/every campaign was paused/i);
    const dd = built.sections.find((s) => s.id === "campaign-deep-dive");
    expect(dd.blocks[0].rows).toHaveLength(2); // still shows them
  });
});
