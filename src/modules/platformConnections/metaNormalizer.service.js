/**
 * Normalizes raw Meta Graph API responses into the exact same schema
 * used by the CSV normalizers in manualUpload.service.js.
 *
 * This means the rule engine (auditEngine.service.js) works identically
 * whether data came from a CSV upload or an OAuth API fetch.
 */

const parseNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (!value) return null;
  const number = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : null;
};

/**
 * Find the value for a given action type in the Meta `actions` array.
 * E.g. getActionValue(actions, 'purchase') → numeric count
 */
const getActionValue = (actions, type) => {
  if (!Array.isArray(actions)) return null;
  const match = actions.find(
    (a) => a.action_type === type || a.action_type?.endsWith(type)
  );
  return match ? parseNumber(match.value) : null;
};

const getCostPerAction = (costPerActionType, type) => {
  if (!Array.isArray(costPerActionType)) return null;
  const match = costPerActionType.find(
    (a) => a.action_type === type || a.action_type?.endsWith(type)
  );
  return match ? parseNumber(match.value) : null;
};

const getRoas = (purchaseRoas) => {
  if (!Array.isArray(purchaseRoas)) return null;
  const match = purchaseRoas.find((r) => r.action_type?.includes("purchase"));
  return match ? parseNumber(match.value) : null;
};

/**
 * Result action types in priority order, spanning Meta objectives so that
 * "results" and cost-per-result are computable for non-purchase accounts —
 * messaging, lead-gen, app installs, subscriptions — not just sales.
 *
 * `getActionValue` matches by suffix, so "purchase" also catches omni_purchase
 * and offsite_conversion.fb_pixel_purchase, "app_install" catches
 * mobile_app_install, etc.
 *
 * Order = which result a mixed actions array reports as the primary one. A
 * messaging or app campaign carries none of the higher-priority types, so it
 * falls through to its own; a sales campaign still reports purchases first.
 * Mid-funnel actions (checkout, add-to-cart) rank last so they only surface
 * when no real conversion exists.
 */
const RESULT_ACTION_PRIORITY = [
  "purchase",
  "lead",
  "lead_grouped",
  "complete_registration",
  "subscribe",
  "start_trial",
  "messaging_conversation_started_7d",
  "total_messaging_connection",
  "app_install",
  "initiate_checkout",
  "initiated_checkout",
  "add_to_cart",
];

/**
 * The primary result count from an actions array, picking the highest-priority
 * objective present (value > 0). Returns null when none are found.
 */
const getPrimaryResult = (actions) => {
  for (const type of RESULT_ACTION_PRIORITY) {
    const value = getActionValue(actions, type);
    if (value != null && value > 0) return value;
  }
  return null;
};

/**
 * Cost per the primary result, matching the same objective priority order.
 */
const getPrimaryResultCpa = (costPerActionType) => {
  for (const type of RESULT_ACTION_PRIORITY) {
    const value = getCostPerAction(costPerActionType, type);
    if (value != null && value > 0) return value;
  }
  return null;
};

// ── Campaign-level ──────────────────────────────────────────────────────────

export const normalizeCampaignInsights = (insights) =>
  insights.map((row) => ({
    level: "campaign",
    name: row.campaign_name,
    status: null, // insights don't include structural status — enriched below
    objective: row.objective || null,
    budget: null,
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    reach: parseNumber(row.reach),
    clicks: parseNumber(row.clicks),
    cpm: parseNumber(row.cpm),
    cpc: parseNumber(row.cpc),
    ctr: parseNumber(row.ctr),
    frequency: parseNumber(row.frequency),
    results: getPrimaryResult(row.actions),
    cpa: getPrimaryResultCpa(row.cost_per_action_type),
    roas: getRoas(row.purchase_roas),
    dateStart: row.date_start,
    dateEnd: row.date_stop,
  }));

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
  insights.map((row) => ({
    level: "adset",
    name: row.adset_name,
    campaignName: row.campaign_name,
    status: null,
    learningPhase: null,
    budget: null,
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    reach: parseNumber(row.reach),
    frequency: parseNumber(row.frequency),
    clicks: parseNumber(row.clicks),
    ctr: parseNumber(row.ctr),
    results: getPrimaryResult(row.actions),
    cpa: getPrimaryResultCpa(row.cost_per_action_type),
    roas: getRoas(row.purchase_roas),
    dateStart: row.date_start,
    dateEnd: row.date_stop,
  }));

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

export const normalizeAdInsights = (insights) =>
  insights.map((row) => ({
    level: "ad",
    name: row.ad_name,
    adSetName: row.adset_name,
    campaignName: row.campaign_name,
    status: null,
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    reach: parseNumber(row.reach),
    frequency: parseNumber(row.frequency),
    clicks: parseNumber(row.clicks),
    ctr: parseNumber(row.ctr),
    results: getPrimaryResult(row.actions),
    cpa: getPrimaryResultCpa(row.cost_per_action_type),
    qualityRanking: row.quality_ranking || null,
    engagementRanking: row.engagement_rate_ranking || null,
    conversionRanking: row.conversion_rate_ranking || null,
    dateStart: row.date_start,
    dateEnd: row.date_stop,
  }));

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
export const normalizeBreakdownInsights = (insights, dimension, segmentField) =>
  (insights || []).map((row) => ({
    dimension,
    segment: row[segmentField] != null ? String(row[segmentField]) : "unknown",
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    clicks: parseNumber(row.clicks),
    reach: parseNumber(row.reach),
    results: getPrimaryResult(row.actions) || 0,
    conversions: getPrimaryResult(row.actions) || 0,
    cpa: getPrimaryResultCpa(row.cost_per_action_type),
  }));

/**
 * Normalize daily time-series rows (time_increment=1).
 */
export const normalizeDailyInsights = (insights) =>
  (insights || []).map((row) => ({
    date: row.date_start,
    spend: parseNumber(row.spend),
    impressions: parseNumber(row.impressions),
    clicks: parseNumber(row.clicks),
    reach: parseNumber(row.reach),
    results: getPrimaryResult(row.actions) || 0,
    conversions: getPrimaryResult(row.actions) || 0,
  }));

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
