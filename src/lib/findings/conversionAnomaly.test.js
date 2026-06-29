import { describe, it, expect } from "vitest";
import { detectConversionAnomalies, normName } from "./conversionAnomaly.js";

// Real fingerprint from the Azzem FxTrader Meta account (PKR): a WhatsApp
// click-to-chat campaign reporting 3,229 "leads" at PKR 13 while genuine
// lead-gen campaigns run PKR 104-157. The blended baseline collapses to ~PKR 53;
// the true baseline (excluding the anomaly) is ~PKR 115.
const azzemCampaigns = [
  { name: "Alt Testing phase 2 | bot", spend: 114886, conversions: 1034 },
  { name: "Alt Testing phase 4th – lp single cr", spend: 56625, conversions: 409 },
  { name: "Alt Testing phase 3 | new videos", spend: 56110, conversions: 539 },
  { name: "Alt Testing phasenew whatsapp", spend: 42809, conversions: 3229 },
  { name: "Alt Testing phase 2 | new cr", spend: 3775, conversions: 24 },
  { name: "New Leads campaign | Sales Person Hiring", spend: 1729, conversions: 11 },
  { name: "New Leads campaign | Sales Person Hiring – Copy", spend: 1073, conversions: 9 },
];

describe("detectConversionAnomalies", () => {
  it("flags the implausibly-cheap WhatsApp campaign and recomputes the true baseline", () => {
    const result = detectConversionAnomalies(azzemCampaigns);
    expect(result).not.toBeNull();
    expect(result.anomalies).toHaveLength(1);
    expect(normName(result.anomalies[0].name)).toContain("whatsapp");

    // Blended baseline is the misleading cheap number; trusted is materially higher.
    expect(result.reportedBaselineCpa).toBeLessThan(60);
    expect(result.trustedBaselineCpa).toBeGreaterThan(100);
    expect(result.trustedBaselineCpa).toBeLessThan(130);
    expect(result.distortion).toBeGreaterThan(1.3);
  });

  it("excludes the anomaly's spend AND conversions from the trusted baseline", () => {
    const result = detectConversionAnomalies(azzemCampaigns);
    expect(result.trustedConversions).toBe(5255 - 3229);
    expect(Math.round(result.trustedSpend)).toBe(Math.round(277007 - 42809));
  });

  it("does NOT flag a healthy account with a normal CPA spread (no false positive)", () => {
    const healthy = [
      { name: "Brand", spend: 5000, conversions: 100 },
      { name: "Prospecting", spend: 8000, conversions: 120 },
      { name: "Retargeting", spend: 3000, conversions: 80 },
      { name: "Lookalike", spend: 4000, conversions: 70 },
      { name: "Search", spend: 6000, conversions: 90 },
    ];
    expect(detectConversionAnomalies(healthy)).toBeNull();
  });

  it("does NOT flag a genuinely efficient but SMALL campaign (volume guard)", () => {
    // One campaign is cheap but carries <15% of conversions — distorts nothing.
    const data = [
      { name: "A", spend: 10000, conversions: 100 },
      { name: "B", spend: 12000, conversions: 110 },
      { name: "C", spend: 9000, conversions: 95 },
      { name: "D", spend: 11000, conversions: 105 },
      { name: "Tiny cheap", spend: 200, conversions: 50 }, // cheap but ~10% of conv
    ];
    const result = detectConversionAnomalies(data);
    expect(result).toBeNull();
  });

  it("needs at least 4 converting peers before judging an anomaly", () => {
    const data = [
      { name: "A", spend: 10000, conversions: 100 },
      { name: "B", spend: 12000, conversions: 110 },
      { name: "WhatsApp", spend: 4000, conversions: 3000 },
    ];
    expect(detectConversionAnomalies(data)).toBeNull();
  });

  it("is currency-agnostic — same ratios in USD trigger identically", () => {
    // Divide PKR figures by ~280 to approximate USD; ratios unchanged.
    const usd = azzemCampaigns.map((c) => ({
      name: c.name,
      spend: c.spend / 280,
      conversions: c.conversions,
    }));
    const result = detectConversionAnomalies(usd);
    expect(result).not.toBeNull();
    expect(result.anomalies).toHaveLength(1);
    expect(result.distortion).toBeGreaterThan(1.3);
  });
});
