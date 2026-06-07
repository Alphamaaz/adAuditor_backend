/**
 * Large-account synthetic fixture.
 *
 * Generates a deterministic ~5K-entity audit context representing a
 * mid-six-figure-per-month account across all 3 platforms. Used for:
 *   - performance harness (p50/p95 timing per rule)
 *   - regression testing of rules whose logic depends on data scale
 *   - benchmark scoring of rule changes against a stable shape
 *
 * Deterministic by seed — same seed produces identical output forever.
 */

import { AuditContextSchema } from "../schemas/context.schema.js";

// ── Deterministic PRNG (mulberry32) ───────────────────────────────────────
const mulberry32 = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = (rnd, list) => list[Math.floor(rnd() * list.length)];
const intBetween = (rnd, lo, hi) => Math.floor(rnd() * (hi - lo + 1)) + lo;
const moneyBetween = (rnd, lo, hi) =>
  Math.round((rnd() * (hi - lo) + lo) * 100) / 100;
// Pareto-ish skew so a small number of campaigns dominate spend (realistic).
const skewedSpend = (rnd, peak = 50000) => {
  const u = rnd();
  return Math.round(peak * Math.pow(1 - u, 3));
};

// ── Generators per platform ────────────────────────────────────────────────
const META_OBJECTIVES = ["OUTCOME_SALES", "OUTCOME_LEADS", "OUTCOME_TRAFFIC"];
const META_STATUSES = ["ACTIVE", "PAUSED", "ACTIVE", "ACTIVE", "LEARNING"];
const META_QUALITY = ["above average", "average", "below average"];

const maybePick = (rnd, list, probability = 0.85) =>
  rnd() < probability ? pick(rnd, list) : undefined;

const buildMetaRecords = (rnd, { campaigns = 45, adsetsPerCampaign = 9, adsPerAdset = 4 } = {}) => {
  const records = [];
  const byLevel = { campaign: [], adset: [], ad: [] };

  for (let c = 0; c < campaigns; c++) {
    const campaignName = `META-Campaign-${c}`;
    const campaignSpend = skewedSpend(rnd, 25000);
    const camp = {
      level: "campaign",
      name: campaignName,
      status: pick(rnd, META_STATUSES),
      objective: pick(rnd, META_OBJECTIVES),
      spend: campaignSpend,
      impressions: intBetween(rnd, 10000, 500000),
      clicks: intBetween(rnd, 100, 5000),
      conversions: intBetween(rnd, 0, 200),
      results: intBetween(rnd, 0, 200),
      roas: rnd() < 0.3 ? Number((rnd() * 0.9).toFixed(2)) : Number((rnd() * 5 + 1).toFixed(2)),
      reach: intBetween(rnd, 5000, 400000),
      frequency: Number((rnd() * 9 + 1).toFixed(2)),
    };
    byLevel.campaign.push(camp);
    records.push(camp);

    for (let a = 0; a < adsetsPerCampaign; a++) {
      const adsetName = `${campaignName}-AdSet-${a}`;
      const isPaused = rnd() < 0.15;
      const adset = {
        level: "adset",
        name: adsetName,
        campaignName,
        status: isPaused ? "PAUSED" : pick(rnd, META_STATUSES),
        budget: rnd() < 0.5 ? moneyBetween(rnd, 10, 500) : 0,
        spend: moneyBetween(rnd, 0, campaignSpend / adsetsPerCampaign),
        impressions: intBetween(rnd, 100, 30000),
        clicks: intBetween(rnd, 0, 500),
        frequency: Number((rnd() * 9 + 0.5).toFixed(2)),
        learningPhase: rnd() < 0.4 ? "LEARNING" : "ACTIVE",
      };
      byLevel.adset.push(adset);
      records.push(adset);

      for (let d = 0; d < adsPerAdset; d++) {
        const ad = {
          level: "ad",
          name: `${adsetName}-Ad-${d}`,
          campaignName,
          adsetName,
          status: pick(rnd, META_STATUSES),
          spend: moneyBetween(rnd, 0, 200),
          impressions: intBetween(rnd, 50, 8000),
          clicks: intBetween(rnd, 0, 150),
          qualityRanking: maybePick(rnd, META_QUALITY),
          engagementRanking: maybePick(rnd, META_QUALITY),
          conversionRanking: maybePick(rnd, META_QUALITY),
        };
        byLevel.ad.push(ad);
        records.push(ad);
      }
    }
  }
  return { records, byLevel };
};

const GOOGLE_MATCH_TYPES = ["BROAD", "PHRASE", "EXACT"];
const GOOGLE_STATUSES = ["ENABLED", "PAUSED", "ENABLED", "ENABLED"];

// Brand terms used by the fixture. Mirror real-world: a handful of brand
// keywords leak into otherwise-generic campaigns, plus a dedicated "Brand"
// campaign for testing GOOGLE-BRAND-SEPARATION-001.
const FIXTURE_BRAND_TERMS = ["acme", "swoosh"];

const buildGoogleRecords = (
  rnd,
  {
    campaigns = 32,
    adGroupsPerCampaign = 7,
    keywordsPerAdGroup = 8,
    searchTermsPerAdGroup = 6,
  } = {}
) => {
  const records = [];
  const byLevel = { campaign: [], adset: [], ad: [], keyword: [], search_term: [] };

  for (let c = 0; c < campaigns; c++) {
    // Campaign index 0 is the dedicated brand campaign; index 1 mixes brand
    // and non-brand keywords (the actionable target for the separation rule).
    const isBrandCampaign = c === 0;
    const isMixedCampaign = c === 1;
    const campaignName = isBrandCampaign
      ? `GOOGLE-Brand-Campaign`
      : `GOOGLE-Campaign-${c}`;
    const campaignSpend = skewedSpend(rnd, 20000);
    const camp = {
      level: "campaign",
      name: campaignName,
      status: pick(rnd, GOOGLE_STATUSES),
      spend: campaignSpend,
      impressions: intBetween(rnd, 5000, 300000),
      clicks: intBetween(rnd, 100, 8000),
      conversions: intBetween(rnd, 0, 300),
      roas: Number((rnd() * 6).toFixed(2)),
    };
    byLevel.campaign.push(camp);
    records.push(camp);

    for (let g = 0; g < adGroupsPerCampaign; g++) {
      const adGroupName = `${campaignName}-AG-${g}`;
      const adGroup = {
        level: "adset",
        name: adGroupName,
        campaignName,
        status: pick(rnd, GOOGLE_STATUSES),
        spend: moneyBetween(rnd, 0, campaignSpend / adGroupsPerCampaign),
      };
      byLevel.adset.push(adGroup);
      records.push(adGroup);

      for (let k = 0; k < keywordsPerAdGroup; k++) {
        // Brand campaign → all brand keywords. Mixed campaign → first 2 are brand.
        // Otherwise → ~10% chance of accidental brand leakage (the target for the rule).
        let kwText;
        if (isBrandCampaign) {
          kwText = `${pick(rnd, FIXTURE_BRAND_TERMS)} keyword ${k}`;
        } else if (isMixedCampaign && k < 2) {
          kwText = `${pick(rnd, FIXTURE_BRAND_TERMS)} mixed leak ${k}`;
        } else if (!isMixedCampaign && rnd() < 0.05) {
          kwText = `${pick(rnd, FIXTURE_BRAND_TERMS)} stray keyword ${c}-${g}-${k}`;
        } else {
          kwText = `keyword ${c}-${g}-${k}`;
        }
        const kw = {
          level: "keyword",
          name: kwText,
          campaignName,
          adGroupName,
          status: pick(rnd, GOOGLE_STATUSES),
          matchType: pick(rnd, GOOGLE_MATCH_TYPES),
          spend: moneyBetween(rnd, 0, 50),
          clicks: intBetween(rnd, 0, 100),
          conversions: intBetween(rnd, 0, 5),
          qualityScore: intBetween(rnd, 1, 10),
        };
        byLevel.keyword.push(kw);
        records.push(kw);
      }

      // Search terms — actual user queries that triggered ads. Used by
      // GOOGLE-SEARCH-TERM-WASTE-001. Some have zero conversions despite
      // meaningful spend + clicks (the actionable waste signal).
      for (let s = 0; s < searchTermsPerAdGroup; s++) {
        const wasted = rnd() < 0.30; // ~30% of search terms are zero-conv waste
        const spend = wasted
          ? moneyBetween(rnd, 21, 80) // above MIN_SPEND_PER_TERM ($20)
          : moneyBetween(rnd, 0, 19);
        const clicks = wasted ? intBetween(rnd, 10, 60) : intBetween(rnd, 0, 9);
        const conversions = wasted ? 0 : intBetween(rnd, 0, 3);
        const st = {
          level: "search_term",
          name: `search query ${c}-${g}-${s}`,
          campaignName,
          adGroupName,
          spend,
          clicks,
          conversions,
        };
        byLevel.search_term.push(st);
        records.push(st);
      }
    }
  }
  return { records, byLevel };
};

const TIKTOK_STATUSES = ["ENABLE", "DISABLE", "ENABLE", "ENABLE"];

const buildTikTokRecords = (rnd, { campaigns = 20, adgroupsPerCampaign = 5, adsPerAdgroup = 4 } = {}) => {
  const records = [];
  const byLevel = { campaign: [], adset: [], ad: [] };

  for (let c = 0; c < campaigns; c++) {
    const campaignName = `TIKTOK-Campaign-${c}`;
    const campaignSpend = skewedSpend(rnd, 12000);
    const camp = {
      level: "campaign",
      name: campaignName,
      status: pick(rnd, TIKTOK_STATUSES),
      spend: campaignSpend,
      impressions: intBetween(rnd, 5000, 200000),
      clicks: intBetween(rnd, 100, 5000),
      conversions: intBetween(rnd, 0, 100),
    };
    byLevel.campaign.push(camp);
    records.push(camp);

    for (let g = 0; g < adgroupsPerCampaign; g++) {
      const groupName = `${campaignName}-Group-${g}`;
      const group = {
        level: "adset",
        name: groupName,
        campaignName,
        status: pick(rnd, TIKTOK_STATUSES),
        spend: moneyBetween(rnd, 0, campaignSpend / adgroupsPerCampaign),
      };
      byLevel.adset.push(group);
      records.push(group);

      for (let d = 0; d < adsPerAdgroup; d++) {
        const ad = {
          level: "ad",
          name: `${groupName}-Ad-${d}`,
          campaignName,
          status: pick(rnd, TIKTOK_STATUSES),
          spend: moneyBetween(rnd, 0, 100),
          impressions: intBetween(rnd, 50, 5000),
          clicks: intBetween(rnd, 0, 200),
        };
        byLevel.ad.push(ad);
        records.push(ad);
      }
    }
  }
  return { records, byLevel };
};

const totals = (records) =>
  records.reduce(
    (acc, r) => {
      acc.spend += r.spend || 0;
      acc.impressions += r.impressions || 0;
      acc.clicks += r.clicks || 0;
      acc.conversions += r.conversions || 0;
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
  );

/**
 * Build a large-account ContextV1.
 * Total entity count with default scale ≈ 5,100 records.
 *
 * @param {object} opts
 * @param {number} opts.seed                Deterministic seed (default 20260526)
 * @param {object} opts.scale               Per-platform scale knobs
 * @returns {object}                        AuditContextSchema-validated context
 */
export const buildLargeAccountContext = (opts = {}) => {
  const seed = opts.seed ?? 20260526;
  const rnd = mulberry32(seed);

  const meta = buildMetaRecords(rnd, opts.scale?.meta);
  const google = buildGoogleRecords(rnd, opts.scale?.google);
  const tiktok = buildTikTokRecords(rnd, opts.scale?.tiktok);

  const ctx = {
    audit: {
      id: "aud_large_account",
      selectedPlatforms: ["META", "GOOGLE", "TIKTOK"],
      dataSource: "MANUAL_UPLOAD",
      businessProfileSnapshot: {
        sectionA: {
          businessType: "eCommerce",
          targetCpa: 50,
          targetRoas: 3.5,
          monthlyBudget: 250000,
          avgOrderValue: 120,
          blendedCac: 65,
        },
        sectionB: {},
        sectionC: {},
      },
      intakeResponses: [
        {
          section: "PLATFORM_META",
          answers: { M5: "yes", M6: "yes", M7: 5, M8: "weekly" },
        },
        { section: "PLATFORM_GOOGLE", answers: {} },
        { section: "PLATFORM_TIKTOK", answers: {} },
      ],
      uploadReadiness: { mode: "FULL" },
    },
    dataset: {
      summary: {
        totals: {
          spend:
            totals(meta.records).spend +
            totals(google.records).spend +
            totals(tiktok.records).spend,
          conversions:
            totals(meta.records).conversions +
            totals(google.records).conversions +
            totals(tiktok.records).conversions,
          uploadedFiles: 3,
          rowCount:
            meta.records.length + google.records.length + tiktok.records.length,
        },
        platforms: {
          META: { uploadedFiles: 1, rowCount: meta.records.length, ...totals(meta.records), reach: 100000 },
          GOOGLE: { uploadedFiles: 1, rowCount: google.records.length, ...totals(google.records), reach: 0 },
          TIKTOK: { uploadedFiles: 1, rowCount: tiktok.records.length, ...totals(tiktok.records), reach: 0 },
        },
      },
      data: {
        platforms: {
          META: { records: meta.records, byLevel: meta.byLevel },
          GOOGLE: { records: google.records, byLevel: google.byLevel },
          TIKTOK: { records: tiktok.records, byLevel: tiktok.byLevel },
        },
      },
    },
    priorAudits: [],
    benchmarks: {},
    now: "2026-05-26T12:00:00.000Z",
  };

  const parsed = AuditContextSchema.safeParse(ctx);
  if (!parsed.success) {
    throw new Error(
      "Large-account fixture failed AuditContextSchema validation:\n" +
        JSON.stringify(parsed.error.issues, null, 2)
    );
  }
  return parsed.data;
};

export const LARGE_ACCOUNT_ENTITY_COUNT = ({ scale } = {}) => {
  const m = scale?.meta ?? {};
  const g = scale?.google ?? {};
  const t = scale?.tiktok ?? {};
  const mCampaigns = m.campaigns ?? 45;
  const mAdsets = m.adsetsPerCampaign ?? 9;
  const mAds = m.adsPerAdset ?? 4;
  const gCampaigns = g.campaigns ?? 32;
  const gAdGroups = g.adGroupsPerCampaign ?? 7;
  const gKeywords = g.keywordsPerAdGroup ?? 8;
  const gSearchTerms = g.searchTermsPerAdGroup ?? 6;
  const tCampaigns = t.campaigns ?? 20;
  const tAdgroups = t.adgroupsPerCampaign ?? 5;
  const tAds = t.adsPerAdgroup ?? 4;

  const meta = mCampaigns * (1 + mAdsets * (1 + mAds));
  // Per Google campaign: 1 campaign + adGroups × (1 adGroup + keywords + searchTerms)
  const google =
    gCampaigns * (1 + gAdGroups * (1 + gKeywords + gSearchTerms));
  const tiktok = tCampaigns * (1 + tAdgroups * (1 + tAds));
  return { meta, google, tiktok, total: meta + google + tiktok };
};
