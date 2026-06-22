import { describe, it, expect } from "vitest";
import { computeAuditDelta, buildDigestEmail } from "./digest.service.js";

const current = {
  healthScore: 74,
  completedAt: "2026-06-21T00:00:00.000Z",
  totals: { spend: 50000, conversions: 400, impressions: 600000, clicks: 30000, currency: "PKR" },
  findings: [
    { ruleId: "CAMP-CPA-001", title: "Campaign dispersion", estimatedImpact: "PKR 4,000 is recoverable", evidence: { confidence: "high" } },
    { ruleId: "GOOGLE-NAMING-001", title: "Inconsistent naming", estimatedImpact: "hygiene", evidence: {} },
  ],
};
const previous = {
  healthScore: 60,
  completedAt: "2026-05-21T00:00:00.000Z",
  totals: { spend: 50000, conversions: 300, impressions: 500000, clicks: 20000 },
  findings: [
    { ruleId: "CAMP-CPA-001", title: "Campaign dispersion", estimatedImpact: "PKR 5,000 is recoverable", evidence: { confidence: "high" } },
    { ruleId: "GOOGLE-GEO-001", title: "Pakistan over baseline", estimatedImpact: "PKR 2,000 is recoverable", evidence: { country: "Pakistan" } },
  ],
};

describe("computeAuditDelta", () => {
  it("returns null without a previous audit", () => {
    expect(computeAuditDelta({ current, previous: null })).toBeNull();
  });

  it("computes toned metric deltas and resolved/new findings", () => {
    const delta = computeAuditDelta({ current, previous, currency: "PKR" });
    const byLabel = Object.fromEntries(delta.metrics.map((m) => [m.label, m]));
    expect(byLabel["Health score"].change).toBe("+14 pts");
    expect(byLabel["Health score"].tone).toBe("good");
    // CPA improved (166.67 → 125).
    expect(byLabel["Cost per acquisition"].tone).toBe("good");
    // Findings diff by ruleId.
    expect(delta.resolved).toContain("Pakistan over baseline"); // gone now
    expect(delta.added).toContain("Inconsistent naming"); // new now
    expect(delta.persisting).toBe(1); // CAMP-CPA persists
  });
});

describe("buildDigestEmail", () => {
  it("renders a weekly digest with metrics and resolved/new lists", () => {
    const delta = computeAuditDelta({ current, previous, currency: "PKR" });
    const { subject, html, text } = buildDigestEmail({ accountName: "Herbal Bazaar", delta, reportUrl: "https://app.x/dashboard/audits/a/results" });
    expect(subject).toContain("Herbal Bazaar");
    expect(html).toContain("Weekly digest");
    expect(html).toContain("Health score");
    expect(html).toContain("Resolved since last audit");
    expect(html).toContain("Open the full audit");
    expect(text).toContain("Pakistan over baseline");
  });

  it("escapes HTML in account name and finding titles", () => {
    const delta = computeAuditDelta({
      current: { ...current, findings: [{ ruleId: "X", title: "<b>x</b>", estimatedImpact: "" }] },
      previous,
      currency: "PKR",
    });
    const { html } = buildDigestEmail({ accountName: "<script>", delta });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
