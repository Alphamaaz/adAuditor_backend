import { describe, it, expect } from "vitest";
import {
  buildCohortBaselines,
  cohortBaselineFor,
  cohortKeyOf,
} from "./cohortBaseline.js";

describe("cohortBaseline", () => {
  it("baselines each conversion type against its own peers", () => {
    const campaigns = [
      { name: "Lead A", resultFamily: "lead", spend: 10000, conversions: 100 }, // 100
      { name: "Lead B", resultFamily: "lead", spend: 12000, conversions: 100 }, // 120
      { name: "Msg A", resultFamily: "messaging", spend: 2000, conversions: 100 }, // 20
      { name: "Msg B", resultFamily: "messaging", spend: 2400, conversions: 100 }, // 24
    ];
    const cohorts = buildCohortBaselines(campaigns);
    expect(cohortBaselineFor(campaigns[0], cohorts)).toBeCloseTo(110, 0); // lead cohort
    expect(cohortBaselineFor(campaigns[2], cohorts)).toBeCloseTo(22, 0); // messaging cohort
  });

  it("does NOT brand a cheap messaging campaign as 'over baseline' vs lead campaigns", () => {
    // A messaging campaign at 115 would look 'over' a blended baseline, but it is
    // the ONLY messaging campaign → no comparable peer → no baseline asserted.
    const campaigns = [
      { name: "Lead A", resultFamily: "lead", spend: 10000, conversions: 100 },
      { name: "Lead B", resultFamily: "lead", spend: 12000, conversions: 100 },
      { name: "Lead C", resultFamily: "lead", spend: 11000, conversions: 100 },
      { name: "Telegram", resultFamily: "messaging", spend: 1150, conversions: 10 }, // CPA 115
    ];
    const cohorts = buildCohortBaselines(campaigns);
    // The Telegram campaign is a singleton in its cohort → no honest baseline.
    expect(cohortBaselineFor(campaigns[3], cohorts)).toBeNull();
    // Lead campaigns still have their own baseline.
    expect(cohortBaselineFor(campaigns[0], cohorts)).toBeGreaterThan(0);
  });

  it("treats family-less data as one cohort (backward compatible)", () => {
    const campaigns = [
      { name: "A", spend: 5000, conversions: 50 },
      { name: "B", spend: 7000, conversions: 50 },
    ];
    const cohorts = buildCohortBaselines(campaigns);
    expect(cohortKeyOf(campaigns[0])).toBe("unknown");
    expect(cohortBaselineFor(campaigns[0], cohorts)).toBeCloseTo(120, 0); // (5000+7000)/100
  });

  it("returns null for a cohort with too few conversions to be stable", () => {
    const campaigns = [
      { name: "A", resultFamily: "lead", spend: 100, conversions: 2 },
      { name: "B", resultFamily: "lead", spend: 100, conversions: 3 },
    ];
    // 5 conversions < COHORT_MIN_CONVERSIONS (10) → not a trustworthy yardstick.
    const cohorts = buildCohortBaselines(campaigns);
    expect(cohortBaselineFor(campaigns[0], cohorts)).toBeNull();
  });
});
