import { describe, it, expect } from "vitest";
import { inferBusinessType, resolveBusinessType } from "./auditEngine.service.js";

const datasetWith = (campaigns) => ({
  data: { platforms: { META: { byLevel: { campaign: campaigns } } } },
});

describe("inferBusinessType", () => {
  it("infers eCommerce from purchase-dominant spend", () => {
    const ds = datasetWith([
      { resultFamily: "purchase", spend: 8000 },
      { resultFamily: "lead", spend: 1000 },
    ]);
    expect(inferBusinessType(ds)).toBe("eCommerce");
  });

  it("infers Lead Gen from lead/messaging spend", () => {
    const ds = datasetWith([
      { resultFamily: "lead", spend: 5000 },
      { resultFamily: "messaging", spend: 3000 },
    ]);
    expect(inferBusinessType(ds)).toBe("Lead Gen");
  });

  it("infers App Install from install spend", () => {
    expect(inferBusinessType(datasetWith([{ resultFamily: "app_install", spend: 4000 }]))).toBe("App Install");
  });

  it("returns null when the signal is ambiguous (traffic only)", () => {
    expect(inferBusinessType(datasetWith([{ resultFamily: "link_click", spend: 4000 }]))).toBeNull();
  });
});

describe("resolveBusinessType", () => {
  const leadData = datasetWith([{ resultFamily: "lead", spend: 5000 }]);

  it("prefers a declared type over the detected one (never overrides the user)", () => {
    const audit = { businessProfileSnapshot: { sectionA: { businessType: "B2B SaaS" } } };
    expect(resolveBusinessType(audit, leadData)).toEqual({ businessType: "B2B SaaS", source: "declared" });
  });

  it("detects from data when the declared type is missing", () => {
    expect(resolveBusinessType({}, leadData)).toEqual({ businessType: "Lead Gen", source: "detected" });
  });

  it("detects from data when the declared type is the generic 'Other'", () => {
    const audit = { businessProfileSnapshot: { sectionA: { businessType: "Other" } } };
    expect(resolveBusinessType(audit, leadData)).toEqual({ businessType: "Lead Gen", source: "detected" });
  });

  it("falls back to 'Other' when nothing can be inferred", () => {
    expect(resolveBusinessType({}, datasetWith([{ resultFamily: "link_click", spend: 100 }]))).toEqual({
      businessType: "Other",
      source: "default",
    });
  });
});
