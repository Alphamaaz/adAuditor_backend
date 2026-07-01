import { describe, it, expect } from "vitest";
import { INDUSTRY_BENCHMARKS, getBenchmark } from "./auditEngine.service.js";

/**
 * Guards the industry-benchmark table (calibrated 2026-07-01 to published 2025/26
 * data). The exact numbers are judgement calls, but the STRUCTURE must always hold:
 *   - CTR / CVR bands descend: good > warning > danger > 0 (higher is better).
 *   - CPM bands ascend: 0 < good < warning < danger (lower is better).
 *   - every platform × business type is present, and getBenchmark falls back to Other.
 * A typo that inverts a band would silently mis-score every account of that type.
 */
const PLATFORMS = ["GOOGLE", "META", "TIKTOK"];
const TYPES = ["eCommerce", "Lead Gen", "App Install", "Local", "B2B SaaS", "Other"];

describe("industry benchmark table integrity", () => {
  it("CTR bands descend good > warning > danger > 0 for every cell", () => {
    for (const platform of PLATFORMS) {
      for (const t of TYPES) {
        const b = INDUSTRY_BENCHMARKS.ctr[platform][t];
        expect(b, `${platform}/${t}`).toBeDefined();
        expect(b.good).toBeGreaterThan(b.warning);
        expect(b.warning).toBeGreaterThan(b.danger);
        expect(b.danger).toBeGreaterThan(0);
      }
    }
  });

  it("CVR table exists and bands descend for every cell", () => {
    expect(INDUSTRY_BENCHMARKS.cvr).toBeDefined();
    for (const platform of PLATFORMS) {
      for (const t of TYPES) {
        const b = INDUSTRY_BENCHMARKS.cvr[platform][t];
        expect(b, `cvr ${platform}/${t}`).toBeDefined();
        expect(b.good).toBeGreaterThan(b.warning);
        expect(b.warning).toBeGreaterThan(b.danger);
        expect(b.danger).toBeGreaterThan(0);
      }
    }
  });

  it("CPM bands ascend 0 < good < warning < danger (Meta + TikTok)", () => {
    for (const platform of ["META", "TIKTOK"]) {
      for (const t of TYPES) {
        const b = INDUSTRY_BENCHMARKS.cpm[platform][t];
        expect(b, `cpm ${platform}/${t}`).toBeDefined();
        expect(b.good).toBeGreaterThan(0);
        expect(b.good).toBeLessThan(b.warning);
        expect(b.warning).toBeLessThan(b.danger);
      }
    }
  });

  it("Google danger CTR stays LOW so Display accounts aren't flagged vs a Search bar", () => {
    // Google figures are Search-network averages; Display CTR is structurally far
    // lower. Danger must stay ≤1% so a normal Display account isn't branded
    // 'critically below benchmark' against a Search bar.
    for (const t of TYPES) {
      expect(INDUSTRY_BENCHMARKS.ctr.GOOGLE[t].danger).toBeLessThanOrEqual(1.0);
    }
  });

  it("getBenchmark falls back to Other for an unknown business type", () => {
    const known = getBenchmark("ctr", "META", "eCommerce");
    const fallback = getBenchmark("ctr", "META", "Underwater Basket Weaving");
    expect(known).toBeDefined();
    expect(fallback).toEqual(INDUSTRY_BENCHMARKS.ctr.META.Other);
  });
});
