/**
 * Normalizes raw Meta Graph API responses into the exact same schema
 * used by the CSV normalizers in manualUpload.service.js.
 *
 * This means the rule engine (auditEngine.service.js) works identically
 * whether data came from a CSV upload or an OAuth API fetch.
 *
 * Result counting is objective-aware — see metaResults.service.js. The old
 * fixed-priority "primary result" picker under-counted messaging accounts ~5×
 * (it preferred a windowed messaging subset over the full count); that poisoned
 * every baseline-derived figure in the audit.
 */

import {
  resolveResult,
  resolveAccountFamilies,
  resultForFamilies,
} from "./metaResults.service.js";

// Re-exported so the controller resolves account-level result families from the
// same place it imports the normalizers.
export { resolveAccountFamilies } from "./metaResults.service.js";

const parseNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
};

const getRoas = (purchaseRoas) => {
  if (!Array.isArray(purchaseRoas)) return null;
  const match = purchaseRoas.find((r) => r.action_type?.includes("purchase"));
  return match ? parseNumber(match.value) : null;
};

/**
 * Cost per result, computed from spend ÷ results so it is always consistent
 * with the result count we report (rather than reading a separate
 * cost-per-action figure that may key off a different action type).
 */
const cpaFromSpend = (spend, results) =>
  results != null && results > 0 && spend != null ? round2(spend / results) : null;

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// ── Campaign-level ──────────────────────────────────────────────────────────

export const normalizeCampaignInsights = (insights) =>
  insights.map((row) => {
    const spend = parseNumber(row.spend);
    const { results, resultFamily } = resolveResult(row.actions, {
      objective: row.objective,
    });
    return {
      level: "campaign",
      name: row.campaign_name,
      status: null, // insights don't include structural status — enriched below
      objective: row.objective || null,
      budget: null,
      spend,
      impressions: parseNumber(row.impressions),
      reach: parseNumber(row.reach),
      clicks: parseNumber(row.clicks),
      cpm: parseNumber(row.cpm),
      cpc: parseNumber(row.cpc),
      ctr: parseNumber(row.ctr),
      frequency: parseNumber(row.frequency),
      // Link clicks (clicks to the destination) are distinct from all-clicks
      // (likes, comments, expansions). Result/link-click is the cleaner read on
      // whether traffic is converting once it lands.
      linkClicks: parseNumber(row.inline_link_clicks),
      results,
      resultFamily,
      cpa: cpaFromSpend(spend, results),
      roas: getRoas(row.purchase_roas),
      dateStart: row.date_start,
      dateEnd: row.date_stop,
    };
  });

/**
 * Enrich campaign insight records with structural data from the /campaigns endpoint.
 * Merges status, budget, and bid_strategy by campaign name.
 */
export const enrichCampaignsWithStructure = (insightRecords, structureRecords) => {
  const byName = {};
  structureRecords.forEach((c) => {
    byName[c.name] = c;
  });

  return insightRecords.map((record) => {
    const struct = byName[record.name];
    if (!struct) return record;
    return {
      ...record,
      status: struct.effective_status || struct.status,
      budget: parseNumber(struct.daily_budget || struct.lifetime_budget),
      bidStrategy: struct.bid_strategy,
      objective: struct.objective || record.objective,
    };
  });
};

// ── Ad set-level ────────────────────────────────────────────────────────────

export const normalizeAdSetInsights = (insights) =>
  insights.map((row) => {
    const spend = parseNumber(row.spend);
    // Ad-set insights carry `optimization_goal`, the most precise result signal.
    const { results, resultFamily } = resolveResult(row.actions, {
      optimizationGoal: row.optimization_goal,
    });
    return {
      level: "adset",
      name: row.adset_name,
      campaignName: row.campaign_name,
      status: null,
      learningPhase: null,
      optimizationGoal: row.optimization_goal || null,
      budget: null,
      spend,
      impressions: parseNumber(row.impressions),
      reach: parseNumber(row.reach),
      frequency: parseNumber(row.frequency),
      clicks: parseNumber(row.clicks),
      ctr: parseNumber(row.ctr),
      results,
      resultFamily,
      cpa: cpaFromSpend(spend, results),
      roas: getRoas(row.purchase_roas),
      dateStart: row.date_start,
      dateEnd: row.date_stop,
    };
  });

export const enrichAdSetsWithStructure = (insightRecords, structureRecords) => {
  const byName = {};
  structureRecords.forEach((s) => {
    byName[s.name] = s;
  });

  return insightRecords.map((record) => {
    const struct = byName[record.name];
    if (!struct) return record;
    return {
      ...record,
      status: struct.effective_status || struct.status,
      learningPhase: struct.learning_phase_info?.status || null,
      budget: parseNumber(struct.daily_budget || struct.lifetime_budget),
    };
  });
};

// ── Ad-level ────────────────────────────────────────────────────────────────

/**
 * Ad-level insight rows don't carry an objective, so result families are
 * resolved once at the account level (from campaign objectives) and passed in.
 */
export const normalizeAdInsights = (insights, families) =>
  insights.map((row) => {
    const spend = parseNumber(row.spend);
    const results = resultForFamilies(row.actions, families);
    return {
      level: "ad",
      name: row.ad_name,
      adSetName: row.adset_name,
      campaignName: row.campaign_name,
      status: null,
      spend,
      impressions: parseNumber(row.impressions),
      reach: parseNumber(row.reach),
      frequency: parseNumber(row.frequency),
      clicks: parseNumber(row.clicks),
      ctr: parseNumber(row.ctr),
      results,
      cpa: cpaFromSpend(spend, results),
      qualityRanking: row.quality_ranking || null,
      engagementRanking: row.engagement_rate_ranking || null,
      conversionRanking: row.conversion_rate_ranking || null,
      dateStart: row.date_start,
      dateEnd: row.date_stop,
    };
  });

/**
 * Flatten Meta's `ad_review_feedback` ({ global|placement_specific: { reason:
 * text } }) into a short, human-readable list of policy reasons.
 */
const summarizeReviewFeedback = (feedback) => {
  if (!feedback || typeof feedback !== "object") return null;
  const reasons = new Set();
  for (const scope of Object.values(feedback)) {
    if (scope && typeof scope === "object") {
      for (const key of Object.keys(scope)) reasons.add(key);
    }
  }
  return reasons.size ? Array.from(reasons).join("; ") : null;
};

export const enrichAdsWithStructure = (insightRecords, structureRecords) => {
  const byName = {};
  structureRecords.forEach((a) => {
    byName[a.name] = a;
  });

  return insightRecords.map((record) => {
    const struct = byName[record.name];
    if (!struct) return record;
    return {
      ...record,
      status: struct.effective_status || struct.status,
      reviewFeedback: summarizeReviewFeedback(struct.ad_review_feedback),
    };
  });
};

// ── Breakdown + daily normalizers ─────────────────────────────────────────────

/**
 * Normalize one breakdown dimension's insight rows into segment records.
 * @param {Array} insights raw Meta rows
 * @param {string} dimension our canonical dimension key (age/gender/...)
 * @param {string} segmentField the Meta response field carrying the value
 */
export const normalizeBreakdownInsights = (insights, dimension, segmentField, families) =>
  (insights || []).map((row) => {
    const spend = parseNumber(row.spend);
    const results = resultForFamilies(row.actions, families) || 0;
    return {
      dimension,
      segment: row[segmentField] != null ? String(row[segmentField]) : "unknown",
      spend,
      impressions: parseNumber(row.impressions),
      clicks: parseNumber(row.clicks),
      reach: parseNumber(row.reach),
      results,
      conversions: results,
      cpa: cpaFromSpend(spend, results),
    };
  });

/**
 * Normalize daily time-series rows (time_increment=1).
 */
export const normalizeDailyInsights = (insights, families) =>
  (insights || []).map((row) => {
    const results = resultForFamilies(row.actions, families) || 0;
    return {
      date: row.date_start,
      spend: parseNumber(row.spend),
      impressions: parseNumber(row.impressions),
      clicks: parseNumber(row.clicks),
      reach: parseNumber(row.reach),
      results,
      conversions: results,
    };
  });

// ── Dataset assembly ─────────────────────────────────────────────────────────

const sumField = (records, field) =>
  records.reduce((total, r) => total + (r[field] || 0), 0);

/**
 * Assemble all fetched Meta records into the NormalizedDataset shape
 * expected by auditEngine.service.js.
 */
export const buildMetaNormalizedDataset = ({
  campaignRecords,
  adSetRecords,
  adRecords,
  currency,
  byDimension = {},
  byDay = [],
}) => {
  const allRecords = [...campaignRecords, ...adSetRecords, ...adRecords];

  const byLevel = {
    campaign: campaignRecords,
    adset: adSetRecords,
    ad: adRecords,
  };

  const summary = {
    uploadedFiles: 1,
    rowCount: allRecords.length,
    spend: sumField(campaignRecords, "spend"),
    impressions: sumField(campaignRecords, "impressions"),
    clicks: sumField(campaignRecords, "clicks"),
    conversions: sumField(campaignRecords, "results"),
    reach: sumField(campaignRecords, "reach"),
    currency: currency || null,
    source: "OAUTH",
  };

  return {
    data: {
      platforms: {
        META: {
          files: [],
          records: allRecords,
          byLevel,
          byDimension: byDimension || {},
          byDay: Array.isArray(byDay) ? byDay : [],
          currency: currency || null,
          source: "OAUTH",
        },
      },
    },
    summary: {
      platforms: { META: summary },
      totals: summary,
    },
  };
};
