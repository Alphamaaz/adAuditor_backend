import { describe, it, expect } from "vitest";
import { buildAuditAlertEmail } from "./alertEmail.service.js";

describe("buildAuditAlertEmail", () => {
  const items = [
    { title: "Ad disapproved and blocking delivery", impact: "PKR 7,089 of delivery blocked", fix: "Edit the ad to clear policy review." },
    { title: "Conversion tracking firing zero", impact: "Needs attention", fix: "Verify the tag fires on the conversion page." },
  ];

  it("summarizes the count and account in the subject", () => {
    const { subject } = buildAuditAlertEmail({ accountName: "Herbal Bazaar", items });
    expect(subject).toContain("2 new issues need attention");
    expect(subject).toContain("Herbal Bazaar");
  });

  it("singularizes for one item", () => {
    const { subject } = buildAuditAlertEmail({ items: [items[0]] });
    expect(subject).toContain("1 new issue need".replace(" need", " ")); // "1 new issue"
    expect(subject).toMatch(/1 new issue /);
  });

  it("includes each item's title, impact and fix in both html and text", () => {
    const { html, text } = buildAuditAlertEmail({ items });
    for (const it of items) {
      expect(html).toContain(it.title);
      expect(html).toContain(it.impact);
      expect(html).toContain(it.fix);
      expect(text).toContain(it.title);
      expect(text).toContain(it.fix);
    }
  });

  it("adds a report CTA only when a URL is provided", () => {
    const withUrl = buildAuditAlertEmail({ items, reportUrl: "https://app.example.com/dashboard/audits/abc/results" });
    expect(withUrl.html).toContain("View the full audit");
    expect(withUrl.text).toContain("https://app.example.com/dashboard/audits/abc/results");
    const without = buildAuditAlertEmail({ items });
    expect(without.html).not.toContain("View the full audit");
  });

  it("escapes HTML in titles (no injection)", () => {
    const { html } = buildAuditAlertEmail({ items: [{ title: "<script>x</script>", impact: "x", fix: "y" }] });
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
