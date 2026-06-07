/**
 * COMPOUND-BRAND-CANNIBALIZATION-001
 *
 * Cross-platform attribution conflict: when an account runs both
 *   (a) Google brand search (paid bids on brand terms), AND
 *   (b) Meta retargeting,
 * brand-search converters get double-counted — Meta retargeting often
 * serves an ad to a user who later searches the brand on Google. Both
 * platforms then claim the conversion, inflating reported ROAS on each.
 *
 * Compound rule — runs in the second pass with frozen findings.
 *
 * Detection:
 *   - signal A: Google brand spend >= MIN_GOOGLE_BRAND_SPEND ($100)
 *     (computed locally from Google keywords matching declared brand terms)
 *   - signal B: Meta retargeting active = intake M5 != "no" AND Meta records exist
 *   - Fire only when BOTH signals are present.
 *
 * Severity: MEDIUM (measurement distortion, not direct spend waste).
 */

import {
  getRecordsByLevel,
  getPlatformAnswers,
  getPlatformRecords,
} from "../shared/context-helpers.js";
import { numberValue } from "../shared/numeric.js";
import { matchesWord } from "../shared/text.js";
import { extractBrandTerms, buildBrandRegex } from "../shared/brand.js";
import { dollar } from "../shared/impactText.js";
import { COMPOUND_BRAND_CANNIBALIZATION as T } from "../shared/thresholds/compound.js";

export default {
  id: "COMPOUND-BRAND-CANNIBALIZATION-001",
  version: "1.0.0",
  platforms: ["CROSS_PLATFORM"],
  category: "Attribution & Reporting",
  severity: "MEDIUM",
  minPlanTier: "free",
  estimatedImpactRange: { min: 0, max: 100000 },
  confidence: "medium",
  requiresHistory: false,
  requiresBenchmarkData: false,
  costToEvaluate: "cheap",
  tags: ["money-rule", "compound", "cross-platform", "tracking"],
  contextVersion: "v1",

  eval(ctx) {
    // ── Signal A: Google brand spend ────────────────────────────────────
    const brandTerms = extractBrandTerms(ctx.audit);
    if (brandTerms.length === 0) return null;

    const googleKeywords = getRecordsByLevel(ctx.dataset, "GOOGLE", "keyword");
    if (googleKeywords.length === 0) return null;

    const brandRegex = buildBrandRegex(brandTerms);
    if (!brandRegex) return null;

    let googleBrandSpend = 0;
    let googleBrandKeywordCount = 0;
    for (const kw of googleKeywords) {
      if (brandRegex.test(String(kw.name || ""))) {
        googleBrandSpend += numberValue(kw.spend);
        googleBrandKeywordCount += 1;
      }
    }
    if (googleBrandSpend < T.MIN_GOOGLE_BRAND_SPEND) return null;

    // ── Signal B: Meta retargeting active ───────────────────────────────
    const metaRecords = getPlatformRecords(ctx.dataset, "META");
    if (metaRecords.length === 0) return null;

    const metaAnswers = getPlatformAnswers(ctx.audit, "META");
    // M5 = "do you run retargeting campaigns on Meta?"
    // If answered "no" → retargeting is NOT active. Any other value
    // (yes, unsure, missing) → presume active when Meta data exists.
    const metaRetargetingExplicitlyOff = matchesWord(metaAnswers.M5, ["no"]);
    if (metaRetargetingExplicitlyOff) return null;

    // Both signals present.
    return {
      ruleId: "COMPOUND-BRAND-CANNIBALIZATION-001",
      platform: "CROSS_PLATFORM",
      severity: "MEDIUM",
      category: "Attribution & Reporting",
      title: `Brand-search and Meta retargeting are likely double-counting conversions on ${dollar(googleBrandSpend)} of brand spend`,
      detail:
        `Google brand-search keywords are consuming ${dollar(googleBrandSpend)} ` +
        `(${googleBrandKeywordCount} brand keyword(s)) while Meta retargeting is also active. ` +
        `Brand-search converters often pass through Meta retargeting first, causing both platforms ` +
        `to claim the same conversion. Reported ROAS on each platform is therefore overstated, ` +
        `and budget reallocation decisions made from these numbers will misroute spend.`,
      evidence: {
        brandTerms,
        googleBrandSpend: Math.round(googleBrandSpend),
        googleBrandKeywordCount,
        metaRetargetingActive: true,
        metaRetargetingSignal:
          metaAnswers.M5 == null ? "presumed_from_data" : metaAnswers.M5,
        signalSources: ["google_brand_keywords", "intake_M5_or_meta_data"],
        thresholds: { minGoogleBrandSpend: T.MIN_GOOGLE_BRAND_SPEND },
      },
      estimatedImpact:
        `Cross-platform double-counting typically overstates ROAS by 10-30% on ` +
        `whichever platform claims the brand-search converter. ` +
        `Resolving this with deduplication does not recover spend, but materially ` +
        `changes which platform earns the next budget increase.`,
      fixSteps: [
        "Configure conversion deduplication: exclude Meta retargeting audiences from Google brand search converters (and vice versa) using audience-list sync.",
        "Use Meta CAPI event_id deduplication aligned to your Google conversion ID where possible.",
        "Compare GA4-attributed conversions side-by-side with Meta-reported and Google-reported numbers to quantify the overlap.",
        "Set distinct attribution windows: typically 1-day-click for Google brand search vs 7-day-click for Meta retargeting.",
        "Re-evaluate budget allocation using GA4 or a deterministic MTA tool, not platform-reported ROAS.",
      ],
    };
  },
};
