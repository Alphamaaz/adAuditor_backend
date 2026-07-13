import { describe, it, expect } from "vitest";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";
import { renderBlock } from "./premiumReportRenderer.service.js";

/**
 * "Since your last audit" — the continuity layer. Compares this audit to the
 * previous one for the same account: metric deltas with a better/worse verdict,
 * plus which findings were resolved vs newly appeared. This is the subscription
 * hook a one-off Claude chat can't replicate.
 */
const baseAudit = (overrides = {}) => ({
  id: "aud_now",
  selectedPlatforms: ["GOOGLE"],
  healthScore: 74,
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  normalizedDataset: {
    summary: {
      totals: { spend: 50000, conversions: 400, impressions: 600000, clicks: 30000, currency: "PKR" },
      platforms: { GOOGLE: { spend: 50000, conversions: 400, impressions: 600000, clicks: 30000, currency: "PKR" } },
    },
    data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: [] }, byDimension: {}, byDay: [], currency: "PKR" } } },
  },
  ruleFindings: [
    { ruleId: "CAMP-CPA-001", platform: "GOOGLE", severity: "HIGH", title: "Campaign dispersion", detail: "x", estimatedImpact: "PKR 4,000 is recoverable", evidence: { level: "campaign", confidence: "high" } },
    { ruleId: "GOOGLE-NAMING-001", platform: "GOOGLE", severity: "LOW", title: "Inconsistent naming", detail: "x", estimatedImpact: "Account hygiene risk.", evidence: {} },
  ],
  ...overrides,
});

const previous = {
  auditId: "aud_prev",
  healthScore: 60,
  completedAt: "2026-05-21T00:00:00.000Z",
  totals: { spend: 50000, conversions: 300, impressions: 500000, clicks: 20000 },
  findings: [
    { ruleId: "CAMP-CPA-001", title: "Campaign dispersion", severity: "CRITICAL", estimatedImpact: "PKR 5,000 is recoverable", evidence: { level: "campaign", confidence: "high" } },
    { ruleId: "GOOGLE-GEO-001", title: "Pakistan runs over baseline", severity: "HIGH", estimatedImpact: "PKR 2,000 is recoverable", evidence: { country: "Pakistan" } },
  ],
};

describe("since-last-audit trend section", () => {
  it("does NOT render on a first audit (no previous)", () => {
    const doc = buildReportDocumentFromAudit(baseAudit());
    expect(doc.sections.find((s) => s.id === "trend")).toBeUndefined();
  });

  it("leads with the trend section when a previous audit exists", () => {
    const doc = buildReportDocumentFromAudit(baseAudit({ previousAudit: previous }));
    expect(doc.sections[0].id).toBe("trend");
  });

  it("scores each metric delta with a better/worse verdict", () => {
    const doc = buildReportDocumentFromAudit(baseAudit({ previousAudit: previous }));
    const trend = doc.sections.find((s) => s.id === "trend").blocks.find((b) => b.type === "trend");
    const byMetric = Object.fromEntries(trend.rows.map((r) => [r.metric, r]));
    // Health 60 → 74 = better.
    expect(byMetric["Health score"].tone).toBe("good");
    expect(byMetric["Health score"].change).toBe("+14 pts");
    // CPA 166.67 → 125 = better (lower).
    expect(byMetric["Cost per acquisition"].tone).toBe("good");
    // CTR 4% → 5% = better (higher).
    expect(byMetric["Click-through rate"].tone).toBe("good");
    // Conversions 300 → 400 = better.
    expect(byMetric["Conversions"].tone).toBe("good");
  });

  it("lists resolved vs new findings by ruleId", () => {
    const doc = buildReportDocumentFromAudit(baseAudit({ previousAudit: previous }));
    const section = doc.sections.find((s) => s.id === "trend");
    const html = section.blocks.map(renderBlock).join("");
    // GEO was on the previous audit, gone now → resolved.
    expect(html).toMatch(/Resolved since last audit.*Pakistan/s);
    // Naming is new this audit → new.
    expect(html).toMatch(/New since last audit.*naming/is);
    // Summary line counts (numbers are markdown-bolded **1**).
    expect(section.blocks[0].text).toMatch(/\*\*1\*\* issue resolved, \*\*1\*\* new, \*\*1\*\* still open/);
  });

  it("renders the trend table with a colored change arrow", () => {
    const doc = buildReportDocumentFromAudit(baseAudit({ previousAudit: previous }));
    const trend = doc.sections.find((s) => s.id === "trend").blocks.find((b) => b.type === "trend");
    const html = renderBlock(trend);
    expect(html).toContain("status-good"); // improving metric colored green
    expect(html).toContain("▲");
  });
});
