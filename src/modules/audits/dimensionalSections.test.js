import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

/**
 * The report must present owned per-dimension sections (funnel/CVR, geo, device,
 * audience) like the reference expert audit — not bury device/geo/funnel insights
 * inside a flat findings list. The funnel/CVR table is the core "is it the ad or
 * the funnel?" call: CPC ÷ target = the CVR needed; actual CVR far below that with
 * healthy clicks localizes the loss downstream.
 */
const audit = () => {
  const campaigns = [
    { level: "campaign", name: "BD | Signals | 6/6", status: "PAUSED", spend: 31920, results: 380, clicks: 10932, cpa: 84 },
    { level: "campaign", name: "PK - Display - 6/16", status: "ENABLED", spend: 19323, results: 56, clicks: 7540, cpa: 345 },
  ];
  const geo = [
    { level: "geo", campaignName: "BD | Signals | 6/6", country: "Bangladesh", spend: 31920, clicks: 10931, conversions: 380 },
    { level: "geo", campaignName: "PK - Display - 6/16", country: "Pakistan", spend: 19323, clicks: 7540, conversions: 56 },
  ];
  const device = [
    { level: "device", campaignName: "PK - Display - 6/16", device: "Mobile", spend: 18688, conversions: 56 },
    { level: "device", campaignName: "PK - Display - 6/16", device: "Desktop", spend: 635, conversions: 0 },
  ];
  const audience_performance = [
    { level: "audience_performance", campaignName: "BD | Signals | 6/6", adGroupName: "Ad group 1", criterionId: "2488177887755", spend: 31920, clicks: 10932, conversions: 380 },
    { level: "audience_performance", campaignName: "PK - Display - 6/16", adGroupName: "Ad group 1", criterionId: "2488177887755", spend: 19323, clicks: 7540, conversions: 56 },
  ];
  const spend = 51243, conversions = 436, clicks = 18472;
  const a = {
    id: "aud_dim",
    selectedPlatforms: ["GOOGLE"],
    dataSource: "OAUTH",
    healthScore: 58,
    businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
    intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
    uploadReadiness: { mode: "FULL" },
    normalizedDataset: {
      summary: { totals: { spend, conversions, currency: "PKR" }, platforms: { GOOGLE: { spend, conversions, clicks, impressions: clicks * 12, currency: "PKR", uploadedFiles: 1, rowCount: 20 } } },
      data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: campaigns, geo, device, audience_performance }, byDimension: {}, byDay: [] } } },
    },
  };
  const res = runDeterministicAudit(a);
  a.ruleFindings = res.findings;
  return buildReportDocumentFromAudit(a);
};

describe("dimensional breakdown sections", () => {
  it("renders funnel/CVR, geo, device, and audience sections", () => {
    const ids = audit().sections.map((s) => s.id);
    for (const id of ["funnel-cvr", "geo-breakdown", "device-breakdown", "audience-segments"]) {
      expect(ids).toContain(id);
    }
  });

  it("funnel table labels a healthy-CTR / low-CVR campaign as downstream", () => {
    const funnel = audit().sections.find((s) => s.id === "funnel-cvr");
    const rows = funnel.blocks[0].rows;
    const pk = rows.find((r) => r[0] === "PK - Display - 6/16");
    const bd = rows.find((r) => r[0] === "BD | Signals | 6/6");
    // PK: needs 3.2%, gets 0.74% → downstream. BD: needs ~3.65%, gets 3.48% → converts.
    expect(pk[4]).toMatch(/downstream/i);
    expect(bd[4]).toMatch(/converts|meets|beats/i);
  });

  it("device table flags a zero-conversion device as waste", () => {
    const device = audit().sections.find((s) => s.id === "device-breakdown");
    const desktop = device.blocks[0].rows.find((r) => r[1] === "Desktop");
    expect(desktop[5]).toMatch(/wasted/i);
  });

  it("omits a dimension when its grain was not pulled", () => {
    // Same account but without geo/device/audience records.
    const a = {
      id: "aud_thin", selectedPlatforms: ["GOOGLE"], dataSource: "OAUTH", healthScore: 60,
      businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 80 } },
      intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
      uploadReadiness: { mode: "FULL" },
      normalizedDataset: {
        summary: { totals: { spend: 30000, conversions: 200, currency: "PKR" }, platforms: { GOOGLE: { spend: 30000, conversions: 200, clicks: 9000, impressions: 100000, currency: "PKR" } } },
        data: { platforms: { GOOGLE: { records: [], byLevel: { campaign: [{ level: "campaign", name: "A", status: "ENABLED", spend: 30000, results: 200, clicks: 9000, cpa: 150 }] }, byDimension: {}, byDay: [] } } },
      },
    };
    const res = runDeterministicAudit(a);
    a.ruleFindings = res.findings;
    const ids = buildReportDocumentFromAudit(a).sections.map((s) => s.id);
    expect(ids).not.toContain("geo-breakdown");
    expect(ids).not.toContain("device-breakdown");
  });
});
