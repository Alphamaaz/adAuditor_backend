/**
 * GOOGLE-BRAND-SEPARATION-001
 *
 * Identifies brand-vs-non-brand keyword leakage across Google campaigns.
 * Brand keywords in non-brand campaigns inflate non-brand ROAS (because
 * brand intent converts at much higher rates). Non-brand keywords in
 * brand campaigns dilute brand ROAS.
 *
 * Detection:
 *   - Require brand terms in audit.businessProfileSnapshot.sectionA.brandTerms
 *     (or brandName fallback). If absent → return null silently.
 *   - Tag each keyword as brand vs non-brand by name word-boundary match.
 *   - Tag each campaign as brand vs non-brand by:
 *        a) campaign name contains brand term, OR
 *        b) >50% of its (brand+non-brand-tagged) keywords are brand
 *   - "Mixed" = brand keywords in non-brand campaigns, or vice versa.
 *   - Fire when mixed_spend >= MIN_MIXED_SPEND AND mixed_keyword_count >= MIN_MIXED_KEYWORDS.
 *
 * Severity: HIGH (structural; distorts every other ROAS-based decision).
 */

import {
  getRecordsByLevel,
} from "../shared/context-helpers.js";
import { numberValue } from "../shared/numeric.js";
import {
  extractBrandTerms,
  buildBrandRegex,
} from "../shared/brand.js";
import { dollar } from "../shared/impactText.js";
import { GOOGLE_BRAND_SEPARATION as T } from "../shared/thresholds/google.js";

export default {
  id: "GOOGLE-BRAND-SEPARATION-001",
  version: "1.0.0",
  platforms: ["GOOGLE"],
  category: "Campaign Structure",
  severity: "HIGH",
  minPlanTier: "free",
  estimatedImpactRange: { min: 0, max: 100000 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["money-rule", "google", "structure", "brand"],
  contextVersion: "v1",

  eval(ctx) {
    const brandTerms = extractBrandTerms(ctx.audit);
    if (brandTerms.length === 0) return null;

    const keywords = getRecordsByLevel(ctx.dataset, "GOOGLE", "keyword");
    const campaigns = getRecordsByLevel(ctx.dataset, "GOOGLE", "campaign");
    if (keywords.length === 0 || campaigns.length === 0) return null;

    const brandRegex = buildBrandRegex(brandTerms);
    if (!brandRegex) return null;

    // Build campaign brand-tag map.
    // Pass 1: count brand vs non-brand keywords per campaign.
    const counts = new Map();
    for (const kw of keywords) {
      const campaignName = kw.campaignName;
      if (!campaignName) continue;
      const isBrandKw = brandRegex.test(String(kw.name || ""));
      const entry = counts.get(campaignName) ?? { brand: 0, nonBrand: 0 };
      if (isBrandKw) entry.brand += 1;
      else entry.nonBrand += 1;
      counts.set(campaignName, entry);
    }

    // Tag each campaign.
    const campaignIsBrand = new Map();
    for (const camp of campaigns) {
      const name = camp.name || "";
      const c = counts.get(name) ?? { brand: 0, nonBrand: 0 };
      const nameSignal = brandRegex.test(name);
      const keywordSignal = c.brand + c.nonBrand > 0 && c.brand / (c.brand + c.nonBrand) > 0.5;
      campaignIsBrand.set(name, nameSignal || keywordSignal);
    }

    // Pass 2: find mixed keywords + sum their spend.
    const brandInNonBrand = [];
    const nonBrandInBrand = [];
    for (const kw of keywords) {
      const name = kw.campaignName;
      if (!name) continue;
      if (!campaignIsBrand.has(name)) continue;
      const campaignBrand = campaignIsBrand.get(name);
      const isBrandKw = brandRegex.test(String(kw.name || ""));
      if (isBrandKw && !campaignBrand) brandInNonBrand.push(kw);
      else if (!isBrandKw && campaignBrand) nonBrandInBrand.push(kw);
    }

    const brandInNonBrandSpend = brandInNonBrand.reduce(
      (s, kw) => s + numberValue(kw.spend),
      0
    );
    const nonBrandInBrandSpend = nonBrandInBrand.reduce(
      (s, kw) => s + numberValue(kw.spend),
      0
    );
    const mixedSpend = brandInNonBrandSpend + nonBrandInBrandSpend;
    const mixedCount = brandInNonBrand.length + nonBrandInBrand.length;

    if (mixedSpend < T.MIN_MIXED_SPEND) return null;
    if (mixedCount < T.MIN_MIXED_KEYWORDS) return null;

    const exampleOf = (list) =>
      [...list]
        .sort((a, b) => numberValue(b.spend) - numberValue(a.spend))
        .slice(0, T.EXAMPLES_COUNT)
        .map((kw) => ({
          keyword: kw.name,
          campaign: kw.campaignName,
          spend: Math.round(numberValue(kw.spend)),
        }));

    return {
      ruleId: "GOOGLE-BRAND-SEPARATION-001",
      platform: "GOOGLE",
      severity: "HIGH",
      category: "Campaign Structure",
      title: `Brand and non-brand keywords are mixed across ${dollar(mixedSpend)} of Google spend`,
      detail:
        `${mixedCount} keyword(s) representing ${dollar(mixedSpend)} are on the ` +
        `wrong side of the brand/non-brand split. ` +
        `Brand-tagged keywords in non-brand campaigns inflate non-brand ROAS; ` +
        `non-brand keywords in brand campaigns dilute brand ROAS and corrupt ` +
        `bid-strategy targets.`,
      evidence: {
        brandTerms,
        mixedSpend: Math.round(mixedSpend),
        mixedCount,
        brandInNonBrandCount: brandInNonBrand.length,
        nonBrandInBrandCount: nonBrandInBrand.length,
        brandInNonBrandSpend: Math.round(brandInNonBrandSpend),
        nonBrandInBrandSpend: Math.round(nonBrandInBrandSpend),
        brandInNonBrandExamples: exampleOf(brandInNonBrand),
        nonBrandInBrandExamples: exampleOf(nonBrandInBrand),
        thresholds: {
          minMixedSpend: T.MIN_MIXED_SPEND,
          minMixedKeywords: T.MIN_MIXED_KEYWORDS,
        },
      },
      estimatedImpact:
        `Mixed brand and non-brand keywords corrupt ROAS measurement on ` +
        `${dollar(mixedSpend)} of spend. Separating them typically lifts ` +
        `non-brand ROAS reporting accuracy by 10-30%, which materially changes ` +
        `which campaigns get budget increases.`,
      fixSteps: [
        "Move every brand-tagged keyword into a dedicated brand campaign.",
        "Move every non-brand keyword out of brand campaigns into intent-aligned non-brand campaigns.",
        "Apply negative keywords to enforce mutual exclusivity (brand negatives in non-brand campaigns and vice versa).",
        "Set distinct Target CPA / ROAS goals for brand vs non-brand campaigns — they have fundamentally different conversion profiles.",
      ],
    };
  },
};
