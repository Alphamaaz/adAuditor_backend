import {
  analyzeDimension,
  baselineCpa,
} from "../../lib/segments/contributionAnalysis.js";
import {
  gateFinding,
  zeroConversionConfident,
  wilsonInterval,
} from "../../lib/stats/significance.js";
import { diagnoseCpaDriver } from "../../lib/kpi/decomposition.js";

const SEVERITY_PENALTIES = {
  CRITICAL: 25,
  HIGH: 15,
  MEDIUM: 8,
  LOW: 3,
};

const PLATFORM_CATEGORIES = {
  META: {
    "Tracking & Pixel Health": 20,
    "Campaign Structure": 20,
    "Audience Strategy": 20,
    "Creative Performance": 15,
    "Bidding & Budget": 15,
    "Retargeting Coverage": 10,
    "Attribution & Reporting": 10,
  },
  GOOGLE: {
    "Conversion Tracking Setup": 20,
    "Campaign Structure": 18,
    "Keyword Strategy": 18,
    "Bidding Strategy Alignment": 15,
    "Ad Copy & Extensions": 12,
    "Quality Score & Relevance": 10,
    "Audience & Attribution": 7,
  },
  TIKTOK: {
    "Pixel & Tracking Health": 22,
    "Creative Performance": 25,
    "Campaign Structure": 18,
    "Audience Strategy": 15,
    "Bidding & Budget": 12,
    "Attribution & Reporting": 8,
  },
};

const SEVERITY_RANK = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const PLATFORM_LABELS = {
  META: "Meta",
  GOOGLE: "Google",
  TIKTOK: "TikTok",
};

export const INDUSTRY_BENCHMARKS = {
  ctr: {
    META: {
      eCommerce:     { good: 1.5, warning: 0.8, danger: 0.4 },
      "Lead Gen":    { good: 1.2, warning: 0.6, danger: 0.3 },
      "App Install": { good: 1.8, warning: 1.0, danger: 0.5 },
      Local:         { good: 1.0, warning: 0.5, danger: 0.25 },
      "B2B SaaS":    { good: 0.8, warning: 0.4, danger: 0.2 },
      Other:         { good: 1.0, warning: 0.5, danger: 0.25 },
    },
    GOOGLE: {
      eCommerce:     { good: 5.0, warning: 2.5, danger: 1.0 },
      "Lead Gen":    { good: 4.5, warning: 2.0, danger: 0.8 },
      "App Install": { good: 3.5, warning: 1.5, danger: 0.6 },
      Local:         { good: 5.5, warning: 2.5, danger: 1.0 },
      "B2B SaaS":    { good: 3.5, warning: 1.5, danger: 0.6 },
      Other:         { good: 4.0, warning: 2.0, danger: 0.8 },
    },
    TIKTOK: {
      eCommerce:     { good: 1.5, warning: 0.7, danger: 0.3 },
      "Lead Gen":    { good: 1.2, warning: 0.6, danger: 0.25 },
      "App Install": { good: 2.0, warning: 1.0, danger: 0.4 },
      Local:         { good: 1.0, warning: 0.5, danger: 0.2 },
      "B2B SaaS":    { good: 0.8, warning: 0.4, danger: 0.2 },
      Other:         { good: 1.0, warning: 0.5, danger: 0.2 },
    },
  },
  cpm: {
    META: {
      eCommerce:     { good: 15, warning: 28, danger: 45 },
      "Lead Gen":    { good: 12, warning: 22, danger: 38 },
      "App Install": { good: 10, warning: 20, danger: 35 },
      Local:         { good: 8,  warning: 18, danger: 30 },
      "B2B SaaS":    { good: 20, warning: 38, danger: 60 },
      Other:         { good: 12, warning: 25, danger: 40 },
    },
    TIKTOK: {
      eCommerce:     { good: 8,  warning: 18, danger: 30 },
      "Lead Gen":    { good: 7,  warning: 15, danger: 25 },
      "App Install": { good: 6,  warning: 14, danger: 22 },
      Local:         { good: 5,  warning: 12, danger: 20 },
      "B2B SaaS":    { good: 10, warning: 20, danger: 35 },
      Other:         { good: 7,  warning: 15, danger: 25 },
    },
  },
};

export const getBenchmark = (metric, platform, businessType) =>
  INDUSTRY_BENCHMARKS[metric]?.[platform]?.[businessType] ||
  INDUSTRY_BENCHMARKS[metric]?.[platform]?.Other ||
  null;

const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const text = (value) => String(value || "").toLowerCase();

const includesAny = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) => values.some((valueItem) => valueItem.includes(term)));
};

// Word-boundary match — prevents "Do not know".includes("no") false positives.
// Use this instead of .includes("no") or includesAny([..., "no", ...]).
const matchesWord = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) =>
    values.some((v) => new RegExp(`\\b${term}\\b`, "i").test(v))
  );
};

const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};

const getPlatformAnswers = (audit, platform) => {
  const intakeResponse = audit.intakeResponses.find(
    (response) => response.section === `PLATFORM_${platform}`
  );

  return intakeResponse?.answers || {};
};

const getPlatformRecords = (dataset, platform) =>
  dataset?.data?.platforms?.[platform]?.records || [];

/**
 * Returns records filtered to a specific entity level. Reads the new
 * `byLevel` map first (post-entity-level normalization), falls back to
 * filtering `records` by the `level` field (legacy datasets).
 */
const getRecordsByLevel = (dataset, platform, level) => {
  const platformData = dataset?.data?.platforms?.[platform];
  if (!platformData) return [];

  if (platformData.byLevel?.[level]) return platformData.byLevel[level];

  return (platformData.records || []).filter(
    (record) => record.level === level
  );
};

const isPausedStatus = (status) => {
  const value = text(status);
  if (!value) return false;
  return (
    value.includes("paused") ||
    value.includes("not delivering") ||
    value === "off"
  );
};

const isLearningStatus = (status) => text(status).includes("learning");

const isBroadMatch = (matchType) => text(matchType).includes("broad");
const isExactMatch = (matchType) => text(matchType).includes("exact");
const isPhraseMatch = (matchType) => text(matchType).includes("phrase");

/**
 * Top-N spend concentration: returns the share of total spend captured by
 * the top `share` (e.g. 0.2 for top 20%) of records ordered by spend desc.
 * If fewer than `minRecords` records or zero spend, returns null.
 */
const topSpendConcentration = (records, share = 0.2, minRecords = 5) => {
  const withSpend = records
    .map((record) => numberValue(record.spend))
    .filter((spend) => spend > 0)
    .sort((left, right) => right - left);

  if (withSpend.length < minRecords) return null;

  const total = withSpend.reduce((acc, spend) => acc + spend, 0);
  if (total <= 0) return null;

  const cutoff = Math.max(1, Math.ceil(withSpend.length * share));
  const topShareSpend = withSpend.slice(0, cutoff).reduce((a, b) => a + b, 0);

  return {
    share: topShareSpend / total,
    topCount: cutoff,
    totalCount: withSpend.length,
    topSpend: topShareSpend,
    totalSpend: total,
  };
};

const sumSpend = (records) =>
  records.reduce((total, record) => total + numberValue(record.spend), 0);

const sumImpressions = (records) =>
  records.reduce((total, record) => total + numberValue(record.impressions), 0);

const sumClicks = (records) =>
  records.reduce((total, record) => total + numberValue(record.clicks), 0);

const sumConversions = (records) =>
  records.reduce(
    (total, record) =>
      total + numberValue(record.conversions ?? record.results),
    0
  );

const getPlatformSummary = (dataset, platform) =>
  dataset?.summary?.platforms?.[platform] || {
    uploadedFiles: 0,
    rowCount: 0,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    reach: 0,
  };

const getTrackingCategory = (platform) =>
  ({ META: "Tracking & Pixel Health", GOOGLE: "Conversion Tracking Setup", TIKTOK: "Pixel & Tracking Health" })[platform] ||
  "Attribution & Reporting";

const getBiddingCategory = (platform) =>
  ({ META: "Bidding & Budget", GOOGLE: "Bidding Strategy Alignment", TIKTOK: "Bidding & Budget" })[platform] ||
  "Bidding & Budget";

const getAttributionCategory = (platform) =>
  ({ META: "Attribution & Reporting", GOOGLE: "Audience & Attribution", TIKTOK: "Attribution & Reporting" })[platform] ||
  "Attribution & Reporting";

const getBusinessProfile = (audit) => {
  const snapshot = audit.businessProfileSnapshot;
  if (!snapshot) return null;
  return {
    sectionA: snapshot.sectionA || {},
    sectionB: snapshot.sectionB || {},
    sectionC: snapshot.sectionC || {},
  };
};

const createFinding = ({
  ruleId,
  platform,
  severity,
  category,
  title,
  detail,
  evidence,
  estimatedImpact,
  fixSteps,
}) => ({
  ruleId,
  platform,
  severity,
  category,
  title,
  detail,
  evidence,
  estimatedImpact,
  fixSteps,
});

const addMetaFindings = ({ audit, dataset, findings }) => {
  const answers = getPlatformAnswers(audit, "META");
  const records = getPlatformRecords(dataset, "META");
  const summary = getPlatformSummary(dataset, "META");

  if (records.length === 0) {
    findings.push(
      createFinding({
        ruleId: "DATA-001",
        platform: "META",
        severity: "CRITICAL",
        category: "Attribution & Reporting",
        title: "No validated Meta data was uploaded",
        detail: "The audit cannot evaluate Meta performance without validated Meta exports.",
        evidence: { uploadedRows: 0 },
        estimatedImpact: "Meta score is limited until account data is uploaded.",
        fixSteps: ["Upload a valid Meta ad, ad set, campaign, or pixel export."],
      })
    );
    return;
  }

  if (matchesWord(answers.M6, ["no"]) || text(answers.M6).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-001",
        platform: "META",
        severity: "HIGH",
        category: "Audience Strategy",
        title: "Existing customer exclusion is not confirmed",
        detail: "Prospecting campaigns can waste spend if existing customers are not excluded.",
        evidence: { M6: answers.M6 },
        estimatedImpact: "Can inflate CPA by spending prospecting budget on existing buyers.",
        fixSteps: [
          "Create a customer list audience.",
          "Exclude it from prospecting ad sets.",
          "Keep the list refreshed from CRM or ecommerce purchases.",
        ],
      })
    );
  }

  if (matchesWord(answers.M5, ["no"])) {
    findings.push(
      createFinding({
        ruleId: "AUD-003",
        platform: "META",
        severity: "HIGH",
        category: "Retargeting Coverage",
        title: "No Meta retargeting campaign was reported",
        detail: "Warm audiences often convert more efficiently than cold traffic.",
        evidence: { M5: answers.M5 },
        estimatedImpact: "Missed low-funnel conversion opportunity.",
        fixSteps: [
          "Create retargeting audiences for site visitors and engaged users.",
          "Split short and longer recency windows where volume allows.",
        ],
      })
    );
  }

  const averageAds = numberValue(answers.M7);
  if (averageAds > 0 && (averageAds < 3 || averageAds > 8)) {
    findings.push(
      createFinding({
        ruleId: "STR-006",
        platform: "META",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Ad volume per ad set is outside the recommended range",
        detail: "Too few ads limits testing; too many ads can fragment delivery.",
        evidence: { averageAdsPerAdSet: averageAds },
        estimatedImpact: "Can slow creative learning and make winners harder to identify.",
        fixSteps: ["Keep roughly 3-8 active ads per ad set during testing."],
      })
    );
  }

  if (includesAny(answers.M8, ["monthly", "rarely"])) {
    findings.push(
      createFinding({
        ruleId: "CRE-001",
        platform: "META",
        severity: "HIGH",
        category: "Creative Performance",
        title: "Creative refresh cadence is slow",
        detail: "Stale creative usually causes fatigue and weaker engagement over time.",
        evidence: { M8: answers.M8 },
        estimatedImpact: "Can increase CPM and CPA as audiences tire of ads.",
        fixSteps: [
          "Create a recurring creative testing cadence.",
          "Refresh hooks, offers, formats, and angles at least bi-weekly where spend allows.",
        ],
      })
    );
  }

  if (summary.impressions > 0 && summary.reach > 0) {
    const frequency = summary.impressions / summary.reach;
    if (frequency > 5) {
      findings.push(
        createFinding({
          ruleId: "AUD-008",
          platform: "META",
          severity: "HIGH",
          category: "Audience Strategy",
          title: "Meta frequency is high",
          detail: "High frequency can indicate audience fatigue or over-narrow targeting.",
          evidence: { frequency: Number(frequency.toFixed(2)) },
          estimatedImpact: "Can increase wasted impressions and reduce conversion efficiency.",
          fixSteps: [
            "Refresh creative.",
            "Expand audience size.",
            "Separate retargeting frequency from prospecting frequency.",
          ],
        })
      );
    }
  }

  // ── Data-driven rules (require entity-level uploads) ──────────────────────

  const adsets = getRecordsByLevel(dataset, "META", "adset");
  const campaigns = getRecordsByLevel(dataset, "META", "campaign");
  const ads = getRecordsByLevel(dataset, "META", "ad");

  // STR-002: Paused ad sets with budget still assigned — wasted account hygiene
  // and a frequent cause of confusion when reviewing a Meta account.
  const pausedAdSetsWithBudget = adsets.filter(
    (record) => isPausedStatus(record.status) && numberValue(record.budget) > 0
  );
  if (pausedAdSetsWithBudget.length > 0) {
    findings.push(
      createFinding({
        ruleId: "STR-002",
        platform: "META",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Paused Meta ad sets still have budgets assigned",
        detail:
          "Paused ad sets with daily/lifetime budgets often confuse pacing reviews and may be re-enabled accidentally with stale targeting.",
        evidence: {
          pausedAdSetsWithBudget: pausedAdSetsWithBudget.length,
          examples: pausedAdSetsWithBudget
            .slice(0, 3)
            .map((record) => ({
              name: record.name,
              campaign: record.campaignName,
              budget: record.budget,
            })),
        },
        estimatedImpact: "Account hygiene and budget pacing decisions degrade.",
        fixSteps: [
          "Archive paused ad sets you don't intend to relaunch.",
          "For ad sets reserved for relaunch, document why budget is retained.",
        ],
      })
    );
  }

  // STR-007: Significant share of ad sets stuck in Learning phase
  if (adsets.length >= 5) {
    const learning = adsets.filter((record) =>
      isLearningStatus(record.learningPhase || record.status)
    );
    const learningShare = learning.length / adsets.length;
    if (learningShare >= 0.3) {
      findings.push(
        createFinding({
          ruleId: "STR-007",
          platform: "META",
          severity: "HIGH",
          category: "Campaign Structure",
          title: "Many Meta ad sets are stuck in the learning phase",
          detail:
            "Meta exits learning when an ad set hits ~50 optimization events in 7 days. A high share stuck in learning indicates fragmented budget or low conversion volume per ad set.",
          evidence: {
            adSetsTotal: adsets.length,
            adSetsLearning: learning.length,
            learningShare: Number((learningShare * 100).toFixed(1)),
          },
          estimatedImpact:
            "Optimization quality is reduced until ad sets exit learning.",
          fixSteps: [
            "Consolidate similar ad sets to increase per-ad-set conversion volume.",
            "Avoid major edits that restart learning.",
            "Use CBO/Advantage+ where appropriate to pool optimization signals.",
          ],
        })
      );
    }
  }

  // BID-004: Spend concentration — top 20% campaigns/ad sets capturing >80% spend
  const concentrationCampaigns = topSpendConcentration(campaigns, 0.2, 5);
  if (concentrationCampaigns && concentrationCampaigns.share >= 0.8) {
    findings.push(
      createFinding({
        ruleId: "BID-004",
        platform: "META",
        severity: "MEDIUM",
        category: "Bidding & Budget",
        title: "Meta spend is heavily concentrated in a few campaigns",
        detail:
          "Heavy concentration creates fragility: if a top spender's performance drops, account-level CPA spikes immediately.",
        evidence: {
          topSharePercent: Number((concentrationCampaigns.share * 100).toFixed(1)),
          topCount: concentrationCampaigns.topCount,
          totalCount: concentrationCampaigns.totalCount,
        },
        estimatedImpact:
          "Performance becomes brittle; one campaign's drop can sink the account.",
        fixSteps: [
          "Identify the top spending campaigns and document why they dominate.",
          "Plan diversification with new audiences or creative tracks.",
          "Set guardrails so a single campaign cannot exceed N% of total spend.",
        ],
      })
    );
  }

  // CRE-003: Ads with poor delivery rankings — only flag when meaningful sample
  if (ads.length >= 5) {
    const belowAverage = ads.filter((record) =>
      [
        record.qualityRanking,
        record.engagementRanking,
        record.conversionRanking,
      ].some((value) => text(value).includes("below average"))
    );
    if (belowAverage.length / ads.length >= 0.25) {
      const belowAverageSpend = sumSpend(belowAverage);
      findings.push(
        createFinding({
          ruleId: "CRE-003",
          platform: "META",
          severity: "HIGH",
          category: "Creative Performance",
          title: "Many Meta ads carry below-average delivery rankings",
          detail:
            "Quality, engagement, or conversion rankings flagged as below average inflate CPM and reduce delivery competitiveness.",
          evidence: {
            adsTotal: ads.length,
            adsBelowAverage: belowAverage.length,
            belowAverageShare: Number(
              ((belowAverage.length / ads.length) * 100).toFixed(1)
            ),
            spendOnBelowAverageAds: Math.round(belowAverageSpend),
          },
          estimatedImpact: `$${Math.round(belowAverageSpend).toLocaleString()} in spend is on below-average ranked ads. Replacing them with higher-quality creative reduces CPM and improves delivery competitiveness.`,
          fixSteps: [
            "Pause ads with multiple below-average rankings.",
            "Iterate on hooks, formats, and visual quality for retained creative.",
            "Run a fresh creative test focused on the weakest dimension.",
          ],
        })
      );
    }
  }

  // STR-008: Active campaigns spending with zero results — direct budget waste
  const totalMetaCampaignSpend = sumSpend(campaigns);
  if (campaigns.length >= 2 && totalMetaCampaignSpend > 0) {
    const minThreshold = Math.max(30, totalMetaCampaignSpend * 0.01);
    const zeroResult = campaigns.filter((record) => {
      const recordSpend = numberValue(record.spend);
      const recordResults = numberValue(record.results ?? record.conversions);
      return (
        recordSpend >= minThreshold &&
        recordResults === 0 &&
        !isPausedStatus(record.status)
      );
    });
    const zeroResultSpend = sumSpend(zeroResult);
    if (zeroResult.length > 0 && zeroResultSpend / totalMetaCampaignSpend >= 0.1) {
      findings.push(
        createFinding({
          ruleId: "STR-008",
          platform: "META",
          severity: zeroResultSpend / totalMetaCampaignSpend >= 0.3 ? "CRITICAL" : "HIGH",
          category: "Campaign Structure",
          title: "Active Meta campaigns are spending with zero recorded results",
          detail: `${zeroResult.length} active campaign(s) consumed $${Math.round(zeroResultSpend).toLocaleString()} without recording a single result. These campaigns are burning budget with no measured return.`,
          evidence: {
            zeroResultCampaigns: zeroResult.length,
            wastedSpend: Math.round(zeroResultSpend),
            wastedSharePercent: Number(
              ((zeroResultSpend / totalMetaCampaignSpend) * 100).toFixed(1)
            ),
            examples: zeroResult
              .slice(0, 3)
              .map((r) => ({ name: r.name, spend: Math.round(numberValue(r.spend)) })),
            ...(() => {
              const z = zeroConversionConfident({
                spend: zeroResultSpend,
                clicks: sumClicks(zeroResult),
              });
              return { confidence: z.confidence, sampleNote: z.sampleNote };
            })(),
          },
          estimatedImpact: `$${Math.round(zeroResultSpend).toLocaleString()} in spend produced zero recorded results. Pausing or restructuring these campaigns directly recovers this budget.`,
          fixSteps: [
            "Check whether the conversion event is correctly configured for each zero-result campaign.",
            "Review whether the campaign objective matches how you measure results.",
            "If the campaigns have been running more than 2 weeks with zero results, pause and restructure.",
            "Verify tracking is firing correctly — zero results can indicate a tracking break, not just poor performance.",
          ],
        })
      );
    }
  }

  // BID-005: Campaigns reporting ROAS < 1.0 — spend exceeds reported revenue
  const campaignsWithRoas = campaigns.filter(
    (record) => numberValue(record.roas) > 0 && numberValue(record.spend) > 50
  );
  if (campaignsWithRoas.length >= 1) {
    const lossMakers = campaignsWithRoas.filter(
      (record) => numberValue(record.roas) < 1.0
    );
    const lossMakersSpend = sumSpend(lossMakers);
    if (lossMakers.length > 0) {
      findings.push(
        createFinding({
          ruleId: "BID-005",
          platform: "META",
          severity:
            lossMakers.length >= campaignsWithRoas.length * 0.5 ? "CRITICAL" : "HIGH",
          category: "Bidding & Budget",
          title: "Meta campaigns reporting ROAS below 1.0 — spend exceeds attributed revenue",
          detail: `${lossMakers.length} campaign(s) with ROAS data are reporting ROAS below 1.0, meaning Meta attributes less than $1 in revenue for every $1 spent. Total spend on these campaigns: $${Math.round(lossMakersSpend).toLocaleString()}.`,
          evidence: {
            lossMakingCampaigns: lossMakers.length,
            totalCampaignsWithRoas: campaignsWithRoas.length,
            lossMakingSpend: Math.round(lossMakersSpend),
            examples: lossMakers.slice(0, 3).map((r) => ({
              name: r.name,
              roas: numberValue(r.roas).toFixed(2),
              spend: Math.round(numberValue(r.spend)),
            })),
          },
          estimatedImpact: `$${Math.round(lossMakersSpend).toLocaleString()} is flowing into campaigns where reported revenue is lower than cost. Note: Meta attribution often overcounts — real losses may be greater.`,
          fixSteps: [
            "Immediately reduce budgets on loss-making campaigns.",
            "Cross-reference Meta ROAS with GA4 or your analytics tool — Meta frequently overcounts conversions.",
            "Review offer, landing page, and audience on each loss-making campaign.",
            "Redirect budget from loss-makers to profitable campaigns.",
          ],
        })
      );
    }
  }

  // AUD-010: Ad-set level frequency above 7 — audience fatigue burning budget
  const highFreqAdSets = adsets.filter(
    (record) => numberValue(record.frequency) > 7 && numberValue(record.spend) > 30
  );
  if (highFreqAdSets.length > 0) {
    const highFreqSpend = sumSpend(highFreqAdSets);
    findings.push(
      createFinding({
        ruleId: "AUD-010",
        platform: "META",
        severity: "HIGH",
        category: "Audience Strategy",
        title: "Multiple Meta ad sets have very high frequency — audience fatigue is likely",
        detail: `${highFreqAdSets.length} ad set(s) have frequency above 7, meaning the average person has seen ads more than 7 times. At this level CPMs rise and conversion rates typically drop sharply.`,
        evidence: {
          highFreqAdSets: highFreqAdSets.length,
          highFreqSpend: Math.round(highFreqSpend),
          examples: highFreqAdSets.slice(0, 3).map((r) => ({
            name: r.name,
            frequency: numberValue(r.frequency).toFixed(1),
            spend: Math.round(numberValue(r.spend)),
          })),
        },
        estimatedImpact: `$${Math.round(highFreqSpend).toLocaleString()} is on saturated ad sets. Refreshing creative or expanding audiences typically restores CPM and conversion rates.`,
        fixSteps: [
          "Introduce new creative to fatigued ad sets immediately.",
          "Expand the audience size to dilute frequency.",
          "Split fatigued audiences into shorter recency windows to sequence messaging.",
          "Consider ad-level frequency caps on placements to prevent future saturation.",
        ],
      })
    );
  }
};

const addGoogleFindings = ({ audit, dataset, findings }) => {
  const answers = getPlatformAnswers(audit, "GOOGLE");
  const records = getPlatformRecords(dataset, "GOOGLE");
  const summary = getPlatformSummary(dataset, "GOOGLE");

  if (records.length === 0) {
    findings.push(
      createFinding({
        ruleId: "DATA-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Conversion Tracking Setup",
        title: "No validated Google data was uploaded",
        detail: "The audit cannot evaluate Google performance without validated Google exports.",
        evidence: { uploadedRows: 0 },
        estimatedImpact: "Google score is limited until account data is uploaded.",
        fixSteps: ["Upload a valid Google campaign, keyword, search term, or time-series export."],
      })
    );
    return;
  }

  if (matchesWord(answers.G11, ["no"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-007",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Conversion Tracking Setup",
        title: "Enhanced Conversions are not configured — Smart Bidding is running on degraded signals",
        detail: `Enhanced Conversions fills the attribution gap caused by cookie consent, iOS privacy changes, and browser tracking restrictions. Without it, Google's Smart Bidding algorithms are receiving fewer and less accurate conversion signals, which directly degrades bid decisions across your $${Math.round(summary.spend || 0).toLocaleString()} in spend.`,
        evidence: { G11: answers.G11, totalSpend: Math.round(summary.spend || 0) },
        estimatedImpact: `Accounts that implement Enhanced Conversions typically recover 10–20% more attributed conversions from the same traffic — on $${Math.round(summary.spend || 0).toLocaleString()} in spend, better attribution directly improves Smart Bidding accuracy.`,
        fixSteps: [
          "Enable Enhanced Conversions for web in Google Ads conversion settings.",
          "Configure the enhanced conversion tag to capture hashed email or phone at purchase.",
          "Verify the diagnostic shows Enhanced Conversions data within 2–3 days of implementation.",
        ],
      })
    );
  }

  const monthlyConversions = numberValue(answers.G3) || summary.conversions;
  if (
    monthlyConversions < 50 &&
    includesAny(answers.G2, ["target cpa", "target roas"])
  ) {
    findings.push(
      createFinding({
        ruleId: "BID-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Bidding Strategy Alignment",
        title: "Smart bidding may not have enough conversion volume",
        detail: "Target CPA/ROAS strategies are risky when conversion volume is below 50 per month.",
        evidence: { monthlyConversions, G2: answers.G2 },
        estimatedImpact: "Can cause unstable delivery, missed volume, or poor CPA control.",
        fixSteps: [
          "Use Maximize Conversions or manual bidding while volume is low.",
          "Consolidate campaigns to increase conversion density where appropriate.",
        ],
      })
    );
  }

  if (matchesWord(answers.G5, ["no", "never"])) {
    findings.push(
      createFinding({
        ruleId: "KW-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Keyword Strategy",
        title: "No negative keyword process is confirmed",
        detail: `Without a confirmed negative keyword process, all $${Math.round(summary.spend || 0).toLocaleString()} in Google spend is exposed to irrelevant search queries. Industry data shows 10–30% of search spend in unmanaged accounts flows to low-intent or completely irrelevant searches. Establishing a weekly search term review is the single highest-leverage Google optimisation for accounts without it.`,
        evidence: { G5: answers.G5, totalSpend: Math.round(summary.spend || 0) },
        estimatedImpact: `10–30% of your $${Math.round(summary.spend || 0).toLocaleString()} in Google spend ($${Math.round((summary.spend || 0) * 0.15).toLocaleString()} estimated at a conservative 15%) may be flowing to irrelevant queries without a negative keyword review process.`,
        fixSteps: [
          "Pull search term reports for the last 30 days across all campaigns.",
          "Create shared negative keyword lists and apply them account-wide.",
          "Separate brand-protection negatives from generic irrelevant query negatives.",
          "Schedule a weekly 30-minute search term review as a recurring media buyer task.",
        ],
      })
    );
  }

  if (includesAny(answers.G5, ["6+ months"])) {
    findings.push(
      createFinding({
        ruleId: "KW-002",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Keyword Strategy",
        title: "Negative keyword list appears stale",
        detail: "Search query behavior changes over time, especially after campaign changes.",
        evidence: { G5: answers.G5 },
        estimatedImpact: "Can gradually increase irrelevant spend.",
        fixSteps: ["Review recent search terms and update shared negative lists."],
      })
    );
  }

  if (
    includesAny(answers.G4, ["broad"]) &&
    includesAny(answers.G2, ["manual cpc", "maximize clicks"])
  ) {
    findings.push(
      createFinding({
        ruleId: "KW-006",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Keyword Strategy",
        title: "Broad match is paired with weak bidding controls",
        detail: "Broad match generally needs strong conversion signals and bidding guardrails.",
        evidence: { G4: answers.G4, G2: answers.G2 },
        estimatedImpact: "Can spend on loose intent queries.",
        fixSteps: [
          "Use phrase/exact match where conversion volume is limited.",
          "Pair broad match with conversion-based bidding and strong negatives.",
        ],
      })
    );
  }

  if (matchesWord(answers.G8, ["no"]) || text(answers.G8).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-006",
        platform: "GOOGLE",
        severity: "MEDIUM",
        category: "Audience & Attribution",
        title: "Audience observation layers are not confirmed — bid adjustment data is missing",
        detail: `Without observation audiences, Google campaigns have no data on which audience segments (remarketing lists, customer match, in-market segments) over- or under-perform. This removes the ability to apply bid adjustments that could reduce CPA or increase ROAS across your $${Math.round(summary.spend || 0).toLocaleString()} in spend.`,
        evidence: { G8: answers.G8, totalSpend: Math.round(summary.spend || 0) },
        estimatedImpact: "Bid adjustments on observation audiences typically improve CPA 10–20% by shifting budget toward segments with demonstrated higher intent.",
        fixSteps: [
          "Add remarketing lists (site visitors, cart abandoners, past converters) in observation mode to all campaigns.",
          "Add customer match lists from CRM data in observation mode.",
          "After 30 days of data, apply positive bid adjustments to high-converting segments.",
        ],
      })
    );
  }

  // ── Data-driven rules (require entity-level uploads) ──────────────────────

  const googleCampaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
  const keywords = getRecordsByLevel(dataset, "GOOGLE", "keyword");
  const searchTerms = getRecordsByLevel(dataset, "GOOGLE", "search_term");

  // KW-007: Broad-match spend share — broad match without conversion bidding
  // is the #1 source of Google waste in our experience.
  if (keywords.length >= 5) {
    const broad = keywords.filter((record) => isBroadMatch(record.matchType));
    const broadSpend = sumSpend(broad);
    const totalKwSpend = sumSpend(keywords);

    if (totalKwSpend > 0) {
      const broadShare = broadSpend / totalKwSpend;
      if (broadShare >= 0.5) {
        findings.push(
          createFinding({
            ruleId: "KW-007",
            platform: "GOOGLE",
            severity: "HIGH",
            category: "Keyword Strategy",
            title: "Most Google keyword spend is on broad match",
            detail:
              "More than half of keyword spend is on broad match. Without strong conversion signals and tight negatives, broad match commonly bleeds budget into low-intent searches.",
            evidence: {
              broadShare: Number((broadShare * 100).toFixed(1)),
              broadSpend: Math.round(broadSpend),
              totalKeywordSpend: Math.round(totalKwSpend),
              broadKeywords: broad.length,
              totalKeywords: keywords.length,
            },
            estimatedImpact: `$${Math.round(broadSpend).toLocaleString()} (${Number((broadShare * 100).toFixed(1))}% of keyword budget) is on broad match. Migrating proven converters to phrase or exact match typically recovers 15-30% of that spend through reduced irrelevant traffic.`,
            fixSteps: [
              "Pull last 30 days of search terms — flag irrelevant queries.",
              "Move proven converters to phrase or exact match.",
              "Tighten negative keyword lists before scaling broad match.",
            ],
          })
        );
      }
    }
  }

  // KW-005: Quality Score < 5 share among keywords with meaningful spend.
  if (keywords.length >= 10) {
    const qualified = keywords.filter(
      (record) => numberValue(record.qualityScore) > 0
    );
    if (qualified.length >= 10) {
      const lowQs = qualified.filter(
        (record) => numberValue(record.qualityScore) < 5
      );
      const lowQsShare = lowQs.length / qualified.length;
      const lowQsSpend = sumSpend(lowQs);
      if (lowQsShare >= 0.3) {
        findings.push(
          createFinding({
            ruleId: "KW-005",
            platform: "GOOGLE",
            severity: "HIGH",
            category: "Quality Score & Relevance",
            title: "A large share of Google keywords have a Quality Score under 5",
            detail:
              "Low Quality Score raises CPCs and weakens ad rank. A persistent low-QS share often signals weak ad-keyword-LP alignment.",
            evidence: {
              lowQsKeywords: lowQs.length,
              evaluatedKeywords: qualified.length,
              lowQsShare: Number((lowQsShare * 100).toFixed(1)),
              lowQsSpend: Math.round(lowQsSpend),
            },
            estimatedImpact: `$${Math.round(lowQsSpend).toLocaleString()} in spend is attributed to low Quality Score keywords. Improving QS to 7+ on this segment reduces CPCs and improves Ad Rank without spending more.`,
            fixSteps: [
              "Group low-QS keywords by ad group and review match between keyword, ad copy, and landing page.",
              "Tighten ad groups around shared intent so headlines can include the keyword.",
              "Improve landing page relevance and load speed.",
            ],
          })
        );
      }
    }
  }

  // KW-003: Search-term irrelevance — high-impression search terms with zero
  // conversions consuming meaningful spend.
  if (searchTerms.length >= 10) {
    const totalStSpend = sumSpend(searchTerms);
    const wasted = searchTerms.filter(
      (record) =>
        numberValue(record.spend) > 0 &&
        numberValue(record.conversions) === 0 &&
        numberValue(record.clicks) >= 5
    );
    const wastedSpend = sumSpend(wasted);
    const wastedShare = totalStSpend > 0 ? wastedSpend / totalStSpend : 0;

    if (wastedShare >= 0.2 && wasted.length >= 5) {
      findings.push(
        createFinding({
          ruleId: "KW-003",
          platform: "GOOGLE",
          severity: "HIGH",
          category: "Keyword Strategy",
          title: "Significant Google spend on search terms with no conversions",
          detail:
            "Search terms with at least 5 clicks and zero conversions are strong negative-keyword candidates. They are visibly burning budget without contributing to results.",
          evidence: {
            wastedSearchTerms: wasted.length,
            totalSearchTerms: searchTerms.length,
            wastedSpend: Math.round(wastedSpend),
            wastedSharePercent: Number((wastedShare * 100).toFixed(1)),
            examples: wasted
              .sort(
                (a, b) => numberValue(b.spend) - numberValue(a.spend)
              )
              .slice(0, 5)
              .map((record) => ({
                searchTerm: record.searchTerm,
                spend: Math.round(numberValue(record.spend)),
                clicks: numberValue(record.clicks),
              })),
          },
          estimatedImpact: `$${Math.round(wastedSpend).toLocaleString()} in spend went to search terms with zero conversions. Adding these as negatives directly recaptures this budget on the next billing cycle.`,
          fixSteps: [
            "Review the highest-spend non-converting search terms.",
            "Add irrelevant terms to a shared negative keyword list.",
            "Consider exact-match conversions only for the affected ad groups.",
          ],
        })
      );
    }
  }

  // STR-001: Budget fragmentation — many low-spend campaigns starve smart bidding
  if (googleCampaigns.length >= 6) {
    const totalGoogleSpend = sumSpend(googleCampaigns);
    if (totalGoogleSpend > 0) {
      const lowSpend = googleCampaigns.filter((record) => {
        const spend = numberValue(record.spend);
        return spend > 0 && spend / totalGoogleSpend < 0.05;
      });
      if (lowSpend.length / googleCampaigns.length >= 0.5) {
        findings.push(
          createFinding({
            ruleId: "STR-001",
            platform: "GOOGLE",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "Google campaign budgets look fragmented",
            detail:
              "Most campaigns each consume <5% of total spend. Fragmented budgets prevent any campaign from accumulating enough conversion volume for stable smart bidding.",
            evidence: {
              campaignsTotal: googleCampaigns.length,
              lowSpendCampaigns: lowSpend.length,
              totalSpend: Math.round(totalGoogleSpend),
            },
            estimatedImpact:
              "Smart bidding learning is unstable; many campaigns underperform their potential.",
            fixSteps: [
              "Consolidate campaigns with similar audiences/objectives.",
              "Use shared budgets where appropriate.",
              "Pause clearly underperforming campaigns and reallocate.",
            ],
          })
        );
      }
    }
  }

  // BID-004: Spend concentration on Google
  const concentrationGoogle = topSpendConcentration(googleCampaigns, 0.2, 5);
  if (concentrationGoogle && concentrationGoogle.share >= 0.8) {
    findings.push(
      createFinding({
        ruleId: "BID-004",
        platform: "GOOGLE",
        severity: "MEDIUM",
        category: "Bidding Strategy Alignment",
        title: "Google spend is heavily concentrated in a few campaigns",
        detail:
          "When 80%+ of spend lives in 20% of campaigns, the account is fragile to one campaign drifting off target.",
        evidence: {
          topSharePercent: Number(
            (concentrationGoogle.share * 100).toFixed(1)
          ),
          topCount: concentrationGoogle.topCount,
          totalCount: concentrationGoogle.totalCount,
        },
        estimatedImpact:
          "Single-point-of-failure risk for the Google channel.",
        fixSteps: [
          "Document why concentration is so high — is it strategy or drift?",
          "Plan diversification: new keyword themes, audiences, or campaign types.",
        ],
      })
    );
  }

  // STR-009: Active Google campaigns with meaningful spend and zero conversions
  if (googleCampaigns.length >= 2) {
    const totalGoogleCampaignSpend2 = sumSpend(googleCampaigns);
    const minGoogleThreshold = Math.max(50, totalGoogleCampaignSpend2 * 0.01);
    const zeroConvCampaigns = googleCampaigns.filter((record) => {
      const recordSpend = numberValue(record.spend);
      const recordConversions = numberValue(record.conversions);
      return (
        recordSpend >= minGoogleThreshold &&
        recordConversions === 0 &&
        !isPausedStatus(record.status)
      );
    });
    const zeroConvSpend = sumSpend(zeroConvCampaigns);
    if (
      zeroConvCampaigns.length > 0 &&
      totalGoogleCampaignSpend2 > 0 &&
      zeroConvSpend / totalGoogleCampaignSpend2 >= 0.1
    ) {
      findings.push(
        createFinding({
          ruleId: "STR-009",
          platform: "GOOGLE",
          severity: zeroConvSpend / totalGoogleCampaignSpend2 >= 0.3 ? "CRITICAL" : "HIGH",
          category: "Conversion Tracking Setup",
          title: "Google campaigns are spending with zero recorded conversions",
          detail: `${zeroConvCampaigns.length} active campaign(s) consumed $${Math.round(zeroConvSpend).toLocaleString()} without recording a single conversion. These campaigns are generating clicks but no measurable return.`,
          evidence: {
            zeroConvCampaigns: zeroConvCampaigns.length,
            wastedSpend: Math.round(zeroConvSpend),
            wastedSharePercent: Number(
              ((zeroConvSpend / totalGoogleCampaignSpend2) * 100).toFixed(1)
            ),
            examples: zeroConvCampaigns
              .slice(0, 3)
              .map((r) => ({ name: r.name, spend: Math.round(numberValue(r.spend)) })),
            ...(() => {
              const z = zeroConversionConfident({
                spend: zeroConvSpend,
                clicks: sumClicks(zeroConvCampaigns),
              });
              return { confidence: z.confidence, sampleNote: z.sampleNote };
            })(),
          },
          estimatedImpact: `$${Math.round(zeroConvSpend).toLocaleString()} produced zero conversions. This is either a tracking problem or a structural inefficiency that compounds with every day of continued spend.`,
          fixSteps: [
            "First rule out a tracking issue: check Conversion Actions and verify tag firing in Google Tag Assistant.",
            "If tracking is confirmed, pause zero-conversion campaigns and diagnose: keyword relevance, landing page quality, and bid strategy.",
            "If these are brand-new campaigns, allow at least 2 weeks and ~50 clicks per ad group before drawing conclusions.",
            "Consider switching to Maximize Conversions (without a target CPA) to let Google learn before adding constraints.",
          ],
        })
      );
    }
  }

  // BID-005: Campaigns where conversion value < spend — ROAS below 1.0 and directly unprofitable
  const campaignsWithConvValue = googleCampaigns.filter(
    (r) => numberValue(r.convValue) > 0 && numberValue(r.spend) > 50
  );
  if (campaignsWithConvValue.length >= 1) {
    const lossMakers = campaignsWithConvValue.filter(
      (r) => numberValue(r.convValue) < numberValue(r.spend)
    );
    const lossMakersSpend = sumSpend(lossMakers);
    if (lossMakers.length > 0) {
      findings.push(
        createFinding({
          ruleId: "BID-005",
          platform: "GOOGLE",
          severity: "CRITICAL",
          category: "Bidding Strategy Alignment",
          title: "Google campaigns have conversion value below spend — these campaigns are directly unprofitable",
          detail: `${lossMakers.length} campaign(s) show conversion value lower than cost, meaning a ROAS below 1.0. Google is reporting less revenue than you are spending on these campaigns.`,
          evidence: {
            lossMakingCampaigns: lossMakers.length,
            totalCampaignsWithValue: campaignsWithConvValue.length,
            lossMakingSpend: Math.round(lossMakersSpend),
            examples: lossMakers.slice(0, 3).map((r) => ({
              name: r.name,
              spend: Math.round(numberValue(r.spend)),
              convValue: Math.round(numberValue(r.convValue)),
              roas: (numberValue(r.convValue) / numberValue(r.spend)).toFixed(2),
            })),
          },
          estimatedImpact: `$${Math.round(lossMakersSpend).toLocaleString()} is flowing into campaigns where Google reports less than $1 in value per $1 spent. Every additional day of spend deepens the loss.`,
          fixSteps: [
            "Immediately reduce budgets on loss-making campaigns.",
            "Verify conversion values are being passed correctly — check the gtag conversionValue parameter.",
            "Cross-check with your order management system: Google's reported value may differ from actual revenue.",
            "Review keyword-to-landing-page alignment and offer quality on the affected campaigns.",
          ],
        })
      );
    }
  }

  // KW-010: Active keywords with zero impressions — disapproved, below first-page bid, or policy-limited
  if (keywords.length >= 5) {
    const activeKeywords = keywords.filter(
      (record) =>
        !text(record.status).includes("paused") &&
        !text(record.status).includes("removed")
    );
    const activeZeroImpression = activeKeywords.filter(
      (record) =>
        numberValue(record.impressions) === 0 && numberValue(record.spend) === 0
    );
    if (
      activeKeywords.length > 0 &&
      activeZeroImpression.length > 0 &&
      activeZeroImpression.length / activeKeywords.length >= 0.2
    ) {
      findings.push(
        createFinding({
          ruleId: "KW-010",
          platform: "GOOGLE",
          severity: "MEDIUM",
          category: "Keyword Strategy",
          title: "Many active Google keywords are getting zero impressions",
          detail: `${activeZeroImpression.length} active keyword(s) (${Math.round((activeZeroImpression.length / activeKeywords.length) * 100)}% of active keywords) received zero impressions in the data period. Common causes: bid below first page, low search volume, disapproval, or keyword-level policy restrictions.`,
          evidence: {
            zeroImpressionKeywords: activeZeroImpression.length,
            activeKeywordsTotal: activeKeywords.length,
            zeroImpressionSharePercent: Number(
              ((activeZeroImpression.length / activeKeywords.length) * 100).toFixed(1)
            ),
            examples: activeZeroImpression
              .slice(0, 5)
              .map((r) => ({ keyword: r.keyword, matchType: r.matchType, status: r.status })),
          },
          estimatedImpact:
            "Zero-impression active keywords inflate account clutter, mask Quality Score problems, and can indicate disapproved ads that need immediate attention.",
          fixSteps: [
            "Check Google Ads status column for 'Below first page bid', 'Low search volume', or 'Disapproved'.",
            "Pause keywords labelled 'Low search volume' — they consume account resources without contributing.",
            "For keywords showing 'Below first page bid', evaluate whether raising the bid is justified by relevance.",
            "Remove duplicate keywords that overlap with better-performing broad or phrase match versions.",
          ],
        })
      );
    }
  }

  // AD-001: RSA asset performance — high share of 'Low' rated assets
  const assets = getRecordsByLevel(dataset, "GOOGLE", "asset");
  if (assets.length >= 5) {
    const ratedAssets = assets.filter(
      (r) =>
        text(r.performance).includes("low") ||
        text(r.performance).includes("good") ||
        text(r.performance).includes("best")
    );
    const lowPerfAssets = ratedAssets.filter((r) =>
      text(r.performance).includes("low")
    );
    if (ratedAssets.length >= 5 && lowPerfAssets.length / ratedAssets.length >= 0.4) {
      findings.push(
        createFinding({
          ruleId: "AD-001",
          platform: "GOOGLE",
          severity: "MEDIUM",
          category: "Ad Copy & Extensions",
          title: "A large share of Google RSA assets are rated 'Low' — ad competitiveness is reduced",
          detail: `${lowPerfAssets.length} of ${ratedAssets.length} rated RSA asset(s) carry a 'Low' performance label. Google uses this rating to determine how often each headline and description is shown. A high proportion of low-rated assets reduces Ad Strength and delivery competitiveness.`,
          evidence: {
            lowPerfAssets: lowPerfAssets.length,
            ratedAssets: ratedAssets.length,
            lowPerfSharePercent: Number(
              ((lowPerfAssets.length / ratedAssets.length) * 100).toFixed(1)
            ),
            examples: lowPerfAssets
              .slice(0, 3)
              .map((r) => ({ asset: r.asset, type: r.type })),
          },
          estimatedImpact:
            "RSAs with many 'Low' assets receive lower Ad Strength scores and are served less frequently. Replacing them with message-matched alternatives improves CTR and Ad Rank without changing bids.",
          fixSteps: [
            "Remove or replace 'Low'-rated assets with new headline/description variations.",
            "Ensure each RSA includes at least 3 headlines containing the primary keyword.",
            "Test benefit-focused and offer-focused headlines against each other.",
            "Avoid pinning headlines unless absolutely necessary — pinning removes Google's ability to optimise combinations.",
          ],
        })
      );
    }
  }
};

const addTikTokFindings = ({ audit, dataset, findings }) => {
  const answers = getPlatformAnswers(audit, "TIKTOK");
  const records = getPlatformRecords(dataset, "TIKTOK");

  if (records.length === 0) {
    findings.push(
      createFinding({
        ruleId: "DATA-001",
        platform: "TIKTOK",
        severity: "CRITICAL",
        category: "Attribution & Reporting",
        title: "No validated TikTok data was uploaded",
        detail: "The audit cannot evaluate TikTok performance without validated TikTok exports.",
        evidence: { uploadedRows: 0 },
        estimatedImpact: "TikTok score is limited until account data is uploaded.",
        fixSteps: ["Upload a valid TikTok campaign, ad group, ad, or pixel export."],
      })
    );
    return;
  }

  if (includesAny(answers.T5, ["neither"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-001",
        platform: "TIKTOK",
        severity: "CRITICAL",
        category: "Pixel & Tracking Health",
        title: "TikTok Pixel or Events API is not configured",
        detail: "TikTok optimization needs event signals to learn from conversion behavior.",
        evidence: { T5: answers.T5 },
        estimatedImpact: "Can prevent accurate conversion optimization.",
        fixSteps: [
          "Install TikTok Pixel.",
          "Configure key conversion events.",
          "Add Events API when engineering support is available.",
        ],
      })
    );
  }

  if (includesAny(answers.T5, ["pixel only"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-003",
        platform: "TIKTOK",
        severity: "HIGH",
        category: "Pixel & Tracking Health",
        title: "Events API is not implemented",
        detail: "Server-side events improve signal reliability when browser tracking is limited.",
        evidence: { T5: answers.T5 },
        estimatedImpact: "Can reduce event match quality and optimization stability.",
        fixSteps: ["Plan Events API implementation for high-value conversion events."],
      })
    );
  }

  if (includesAny(answers.T3, ["monthly", "rarely"])) {
    findings.push(
      createFinding({
        ruleId: "CRE-001",
        platform: "TIKTOK",
        severity: "HIGH",
        category: "Creative Performance",
        title: "TikTok creative refresh cadence is too slow",
        detail: "TikTok fatigue cycles are usually faster than Meta or Google.",
        evidence: { T3: answers.T3 },
        estimatedImpact: "Can quickly reduce CTR and increase CPA.",
        fixSteps: [
          "Produce new hooks weekly where spend allows.",
          "Rotate creator, format, angle, and first-three-second opening.",
        ],
      })
    );
  }

  if (matchesWord(answers.T8, ["no"]) || text(answers.T8).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-001",
        platform: "TIKTOK",
        severity: "HIGH",
        category: "Audience Strategy",
        title: "Existing customer exclusion is not confirmed",
        detail: "Prospecting campaigns can waste budget on people who already purchased.",
        evidence: { T8: answers.T8 },
        estimatedImpact: "Can overstate prospecting performance and inflate CAC.",
        fixSteps: ["Exclude customer lists from prospecting ad groups where possible."],
      })
    );
  }

  const pausedWithBudget = records.filter(
    (record) => isPausedStatus(record.status) && numberValue(record.budget) > 0
  );

  if (pausedWithBudget.length > 0) {
    findings.push(
      createFinding({
        ruleId: "STR-005",
        platform: "TIKTOK",
        severity: "MEDIUM",
        category: "Campaign Structure",
        title: "Paused TikTok campaigns still show budget",
        detail: "Paused campaigns with budgets can confuse account review and budget planning.",
        evidence: { pausedCampaigns: pausedWithBudget.length },
        estimatedImpact: "Budget visibility and pacing decisions become less reliable.",
        fixSteps: ["Clean up paused campaigns or document why budget remains assigned."],
      })
    );
  }

  // ── Data-driven rules ─────────────────────────────────────────────────────

  const tiktokCampaigns = getRecordsByLevel(dataset, "TIKTOK", "campaign");
  const tiktokAds = getRecordsByLevel(dataset, "TIKTOK", "ad");

  // BID-004: TikTok spend concentration
  const tiktokConcentration = topSpendConcentration(tiktokCampaigns, 0.2, 4);
  if (tiktokConcentration && tiktokConcentration.share >= 0.8) {
    findings.push(
      createFinding({
        ruleId: "BID-004",
        platform: "TIKTOK",
        severity: "MEDIUM",
        category: "Bidding & Budget",
        title: "TikTok spend is heavily concentrated in a few campaigns",
        detail:
          "TikTok performance can swing fast on creative. Heavy spend concentration amplifies that risk.",
        evidence: {
          topSharePercent: Number(
            (tiktokConcentration.share * 100).toFixed(1)
          ),
          topCount: tiktokConcentration.topCount,
          totalCount: tiktokConcentration.totalCount,
        },
        estimatedImpact:
          "Account-level CPA can swing sharply when a single campaign's creative fatigues.",
        fixSteps: [
          "Diversify across creative themes or audiences.",
          "Set per-campaign spend ceilings to limit single-point risk.",
        ],
      })
    );
  }

  // CRE-002: Low-CTR TikTok ads carrying significant spend (proxy for hook rate)
  if (tiktokAds.length >= 5) {
    const totalAdSpend = sumSpend(tiktokAds);
    const lowCtr = tiktokAds.filter((record) => {
      const ctr = numberValue(record.ctr);
      const spend = numberValue(record.spend);
      return ctr > 0 && ctr < 0.5 && spend > 0;
    });
    const lowCtrSpend = sumSpend(lowCtr);
    if (
      totalAdSpend > 0 &&
      lowCtrSpend / totalAdSpend >= 0.3 &&
      lowCtr.length >= 3
    ) {
      findings.push(
        createFinding({
          ruleId: "CRE-002",
          platform: "TIKTOK",
          severity: "HIGH",
          category: "Creative Performance",
          title: "Significant TikTok spend is going to low-CTR ads",
          detail:
            "When ads with CTR under 0.5% absorb 30%+ of spend, the creative is failing to earn attention. CTR in the 1-2%+ range is typical for healthy TikTok ads.",
          evidence: {
            lowCtrAds: lowCtr.length,
            totalAds: tiktokAds.length,
            lowCtrSpend: Math.round(lowCtrSpend),
            lowCtrSpendShare: Number(
              ((lowCtrSpend / totalAdSpend) * 100).toFixed(1)
            ),
          },
          estimatedImpact: `$${Math.round(lowCtrSpend).toLocaleString()} (${Number(((lowCtrSpend / totalAdSpend) * 100).toFixed(1))}% of ad spend) is going to ads with CTR below 0.5%. Reallocating to stronger creative directly improves ROAS without increasing budget.`,
          fixSteps: [
            "Pause the lowest-CTR ads and shift budget to top performers.",
            "Test stronger 1-3 second hooks on remaining ads.",
            "Iterate on creator, format, and pattern interrupts.",
          ],
        })
      );
    }
  }

  // STR-008: TikTok campaigns with spend and zero conversions
  if (tiktokCampaigns.length >= 2) {
    const totalTikTokSpend = sumSpend(tiktokCampaigns);
    const minTikTokThreshold = Math.max(30, totalTikTokSpend * 0.01);
    const zeroConvTikTok = tiktokCampaigns.filter((record) => {
      const recordSpend = numberValue(record.spend);
      const recordConversions = numberValue(record.conversions);
      return recordSpend >= minTikTokThreshold && recordConversions === 0;
    });
    const zeroConvTikTokSpend = sumSpend(zeroConvTikTok);
    if (
      zeroConvTikTok.length > 0 &&
      totalTikTokSpend > 0 &&
      zeroConvTikTokSpend / totalTikTokSpend >= 0.1
    ) {
      findings.push(
        createFinding({
          ruleId: "STR-008",
          platform: "TIKTOK",
          severity: zeroConvTikTokSpend / totalTikTokSpend >= 0.3 ? "CRITICAL" : "HIGH",
          category: "Campaign Structure",
          title: "TikTok campaigns are spending with zero recorded conversions",
          detail: `${zeroConvTikTok.length} TikTok campaign(s) consumed $${Math.round(zeroConvTikTokSpend).toLocaleString()} without recording a single conversion. On TikTok, zero conversions after meaningful spend almost always points to a pixel issue, wrong optimisation event, or creative that cannot bridge the intent gap to purchase.`,
          evidence: {
            zeroConvCampaigns: zeroConvTikTok.length,
            wastedSpend: Math.round(zeroConvTikTokSpend),
            wastedSharePercent: Number(
              ((zeroConvTikTokSpend / totalTikTokSpend) * 100).toFixed(1)
            ),
            examples: zeroConvTikTok
              .slice(0, 3)
              .map((r) => ({ name: r.name, spend: Math.round(numberValue(r.spend)) })),
          },
          estimatedImpact: `$${Math.round(zeroConvTikTokSpend).toLocaleString()} produced no conversions. This is either a tracking problem or the creative is not generating purchase intent.`,
          fixSteps: [
            "Check TikTok Pixel Helper to confirm the pixel fires on the conversion page.",
            "Verify the optimisation event (e.g. CompletePayment) is recording in TikTok Events Manager.",
            "If tracking is confirmed, review creative: the hook, offer, and CTA must match the audience's buying intent.",
            "Test with a Broad Audience campaign to let TikTok's algorithm find converters before narrowing targeting.",
          ],
        })
      );
    }
  }

  // CRE-003: High CPM with low CTR — expensive impressions failing to earn clicks
  const tiktokAdGroups = getRecordsByLevel(dataset, "TIKTOK", "adgroup");
  const adsWithCpmCtr = tiktokAds.filter(
    (r) => numberValue(r.cpm) > 0 && numberValue(r.ctr) > 0
  );
  if (adsWithCpmCtr.length >= 3) {
    const totalTikTokAdSpend = sumSpend(tiktokAds);
    const avgCpm =
      adsWithCpmCtr.reduce((acc, r) => acc + numberValue(r.cpm), 0) /
      adsWithCpmCtr.length;
    const highCpmLowCtr = adsWithCpmCtr.filter(
      (r) => numberValue(r.cpm) > avgCpm * 1.5 && numberValue(r.ctr) < 0.5
    );
    const highCpmLowCtrSpend = sumSpend(highCpmLowCtr);
    if (
      highCpmLowCtr.length > 0 &&
      totalTikTokAdSpend > 0 &&
      highCpmLowCtrSpend / totalTikTokAdSpend >= 0.15
    ) {
      findings.push(
        createFinding({
          ruleId: "CRE-003",
          platform: "TIKTOK",
          severity: "HIGH",
          category: "Creative Performance",
          title: "TikTok ads have high CPM but very low CTR — budget is burning on unclicked impressions",
          detail: `${highCpmLowCtr.length} ad(s) have CPM above 1.5× the account average ($${avgCpm.toFixed(2)}) but CTR below 0.5%. These ads are winning expensive auction slots but failing to generate clicks — a sign of mismatched creative or wrong audience.`,
          evidence: {
            highCpmLowCtrAds: highCpmLowCtr.length,
            accountAvgCpm: +avgCpm.toFixed(2),
            highCpmLowCtrSpend: Math.round(highCpmLowCtrSpend),
            examples: highCpmLowCtr.slice(0, 3).map((r) => ({
              name: r.name,
              cpm: numberValue(r.cpm).toFixed(2),
              ctr: numberValue(r.ctr).toFixed(2),
              spend: Math.round(numberValue(r.spend)),
            })),
          },
          estimatedImpact: `$${Math.round(highCpmLowCtrSpend).toLocaleString()} is on ads that cost above average to show but fail to earn clicks. Native-style creative typically improves CTR 2-3× and reduces effective CPM.`,
          fixSteps: [
            "Pause high-CPM, low-CTR ads and shift budget to your highest-CTR creatives.",
            "Review the hook (first 1-3 seconds): if it looks like an ad, TikTok users scroll past.",
            "Test UGC-style, native-format creative without branded intros or obvious sales pitches.",
            "Check audience targeting — high CPMs often indicate audiences that are too narrow or have inflated bids.",
          ],
        })
      );
    }
  }
};

const addDataQualityFindings = ({ audit, dataset, findings }) => {
  for (const platform of audit.selectedPlatforms) {
    const platformSummary = getPlatformSummary(dataset, platform);
    const readiness = audit.uploadReadiness?.platforms?.[platform];

    if (platformSummary.uploadedFiles > 0 && platformSummary.rowCount < 3) {
      findings.push(
        createFinding({
          ruleId: "DATA-002",
          platform,
          severity: "LOW",
          category: "Attribution & Reporting",
          title: `${PLATFORM_LABELS[platform]} audit has limited row coverage`,
          detail: "The audit can run, but findings are less confident with very few rows.",
          evidence: { rowCount: platformSummary.rowCount },
          estimatedImpact: "Recommendations should be treated as directional.",
          fixSteps: ["Upload additional report types or a fuller export when available."],
        })
      );
    }

    if (readiness?.missingReports?.length) {
      findings.push(
        createFinding({
          ruleId: "DATA-003",
          platform,
          severity: "MEDIUM",
          category: "Attribution & Reporting",
          title: `${PLATFORM_LABELS[platform]} audit is running with incomplete report coverage`,
          detail: "The audit can run in limited mode, but full confidence requires all required platform exports.",
          evidence: {
            missingReports: readiness.missingReports.map((report) => report.label),
            uploadedReports: readiness.uploadedReports.map((report) => report.label),
          },
          estimatedImpact: "Some rules may be skipped or less confident until all required reports are uploaded.",
          fixSteps: [
            "Upload the missing reports listed in the readiness checklist.",
            "Run the audit again after the checklist is complete.",
          ],
        })
      );
    }
  }
};

const addBusinessProfileFindings = ({ audit, dataset, findings }) => {
  const profile = getBusinessProfile(audit);
  if (!profile) return;

  const { sectionA, sectionB, sectionC } = profile;
  const platforms = audit.selectedPlatforms;

  // ── B1: Pixel / conversion tag not installed ──────────────────────────────
  if (matchesWord(sectionB.pixelInstalled, ["no"])) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-001",
          platform,
          severity: "CRITICAL",
          category: getTrackingCategory(platform),
          title: "Pixel / conversion tag is not installed or verified",
          detail:
            "Without a tracking pixel or conversion tag the ad platform has no signal to measure results or optimise bidding. This is the single most common root cause of wasted ad spend.",
          evidence: { B1: sectionB.pixelInstalled },
          estimatedImpact:
            "All smart-bidding strategies are running blind. Conversion reporting is inaccurate or empty.",
          fixSteps: [
            "Install the platform pixel on every page of your website.",
            "Verify the pixel fires on the primary conversion page using the platform's diagnostic tool.",
            "Set up at least one primary conversion event before running any spend.",
          ],
        })
      );
    }
  }

  // ── B2: Wrong conversion event ────────────────────────────────────────────
  if (
    matchesWord(sectionB.correctConversionEvent, ["no"]) ||
    text(sectionB.correctConversionEvent).includes("unsure")
  ) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-002",
          platform,
          severity: "HIGH",
          category: getTrackingCategory(platform),
          title: "Conversion event may not match campaign objective",
          detail:
            "Optimising to the wrong event — for example Add to Cart instead of Purchase — teaches the bidding algorithm to target the wrong users. The algorithm maximises what you measure, not what you actually want.",
          evidence: { B2: sectionB.correctConversionEvent },
          estimatedImpact:
            "Bidding algorithms learn incorrect behaviour, systematically inflating your real CPA.",
          fixSteps: [
            "Audit active conversion events in each platform's settings.",
            "Ensure the primary event matches your objective: Sales → Purchase, Leads → Lead Submit.",
            "Demote mismatched events to 'Informational' or secondary status.",
          ],
        })
      );
    }
  }

  // ── B3: UTM inconsistency ─────────────────────────────────────────────────
  if (
    matchesWord(sectionB.utmConsistency, ["no"]) ||
    text(sectionB.utmConsistency).includes("inconsistently")
  ) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-003",
          platform,
          severity: "MEDIUM",
          category: getAttributionCategory(platform),
          title: "UTM parameters are missing or inconsistent",
          detail:
            "Without consistent UTMs, GA4 and third-party analytics tools cannot validate platform-reported conversions. Platform-reported conversion numbers are frequently 20-40% inflated versus independently tracked data.",
          evidence: { B3: sectionB.utmConsistency },
          estimatedImpact:
            "Attribution data is unreliable. You cannot independently verify platform ROAS or conversion counts.",
          fixSteps: [
            "Define a UTM naming convention and document it in a shared template.",
            "Use a URL builder tool or spreadsheet for every ad link.",
            "Spot-check GA4 to confirm utm_source, utm_medium, and utm_campaign are populating.",
          ],
        })
      );
    }
  }

  // ── B5: No server-side tracking ───────────────────────────────────────────
  if (matchesWord(sectionB.serverSideTracking, ["no"])) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-TRK-004",
          platform,
          severity: platform === "GOOGLE" ? "MEDIUM" : "HIGH",
          category: getTrackingCategory(platform),
          title: "Server-side tracking is not implemented",
          detail:
            "Post-iOS 14 browser privacy restrictions block 20-40% of pixel events. Server-side tracking (Meta CAPI, TikTok Events API, Google Enhanced Conversions) sends events directly from your server, restoring signal quality and allowing algorithms to optimise accurately.",
          evidence: { B5: sectionB.serverSideTracking },
          estimatedImpact:
            "Conversion undercounting suppresses algorithm optimisation. Reported ROAS is likely understated and campaign delivery is weaker than it could be.",
          fixSteps: [
            "Implement server-side events via your backend, Shopify integration, or a tag management server (e.g. Stape).",
            "Run pixel and server-side events in parallel to check event match quality.",
            "Verify event match quality score reaches 6+ in Meta Events Manager or equivalent.",
          ],
        })
      );
    }
  }

  // ── A3: Target CPA miss ───────────────────────────────────────────────────
  const targetCpa = numberValue(sectionA.targetCpa);
  if (targetCpa > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        const actualCpa = summary.spend / summary.conversions;
        const ratio = actualCpa / targetCpa;
        if (ratio >= 1.5) {
          findings.push(
            createFinding({
              ruleId: "BP-PERF-001",
              platform,
              severity: ratio >= 2.5 ? "CRITICAL" : "HIGH",
              category: getBiddingCategory(platform),
              title: `${PLATFORM_LABELS[platform]} CPA is significantly above your declared target`,
              detail: `Your declared target CPA is $${targetCpa}. The actual CPA in this data is $${actualCpa.toFixed(2)} — ${ratio.toFixed(1)}× your goal. Every acquisition is costing far more than your business model planned for.`,
              evidence: {
                targetCpa,
                actualCpa: Math.round(actualCpa * 100) / 100,
                multiplier: +ratio.toFixed(1),
                totalSpend: Math.round(summary.spend),
                totalConversions: summary.conversions,
              },
              estimatedImpact: `At ${ratio.toFixed(1)}× your target, the cost of inaction compounds with every dollar of additional spend.`,
              fixSteps: [
                "Identify the top-spending campaigns and ad sets with CPA furthest above target — pause or cap them first.",
                "Review bidding strategy: check whether conversion volume is sufficient for stable smart bidding.",
                "Audit the conversion event being optimised — confirm it matches the intended action.",
                "Test landing page conversion rate improvements; ad-side CPA is often constrained by post-click performance.",
              ],
            })
          );
        }
      }
    }
  }

  // ── A4 + A5: Target ROAS miss (estimated from conversions × avg order value) ─
  const targetRoas = numberValue(sectionA.targetRoas);
  const avgOrderValue = numberValue(sectionA.avgOrderValue);
  if (targetRoas > 0 && avgOrderValue > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        const estimatedRevenue = summary.conversions * avgOrderValue;
        const estimatedRoas = estimatedRevenue / summary.spend;
        const ratio = estimatedRoas / targetRoas;
        if (ratio < 0.7) {
          findings.push(
            createFinding({
              ruleId: "BP-PERF-002",
              platform,
              severity: ratio < 0.4 ? "CRITICAL" : "HIGH",
              category: getBiddingCategory(platform),
              title: `${PLATFORM_LABELS[platform]} estimated ROAS is significantly below your target`,
              detail: `Using your declared average order value of $${avgOrderValue}, the estimated ROAS from this data is ${estimatedRoas.toFixed(2)}× against your target of ${targetRoas}×. The account is returning roughly ${Math.round(ratio * 100)}% of your intended return.`,
              evidence: {
                targetRoas,
                estimatedRoas: +estimatedRoas.toFixed(2),
                avgOrderValue,
                totalSpend: Math.round(summary.spend),
                estimatedRevenue: Math.round(estimatedRevenue),
                percentOfTarget: Math.round(ratio * 100),
              },
              estimatedImpact: `At ${estimatedRoas.toFixed(2)}× vs a ${targetRoas}× target, scaling spend in this state accelerates losses.`,
              fixSteps: [
                "Identify and pause the lowest-ROAS campaigns first.",
                "Shift budget toward the highest-ROAS ad sets or campaigns.",
                "Confirm the conversion event captures revenue value correctly.",
                "Assess whether landing page or offer quality is limiting post-click conversion.",
              ],
            })
          );
        }
      }
    }
  }

  // ── A2: Budget under-delivery ─────────────────────────────────────────────
  const monthlyBudget = numberValue(sectionA.monthlyBudget);
  if (monthlyBudget > 0) {
    const totalActualSpend = platforms.reduce(
      (acc, platform) => acc + getPlatformSummary(dataset, platform).spend,
      0
    );
    if (totalActualSpend > 0) {
      const deliveryRate = totalActualSpend / monthlyBudget;
      if (deliveryRate < 0.6) {
        const primaryPlatform =
          platforms.find((p) => getPlatformSummary(dataset, p).spend > 0) || platforms[0];
        findings.push(
          createFinding({
            ruleId: "BP-PERF-003",
            platform: primaryPlatform,
            severity: "MEDIUM",
            category: getBiddingCategory(primaryPlatform),
            title: "Ad spend is significantly below your declared monthly budget",
            detail: `Your declared monthly budget is $${monthlyBudget.toLocaleString()}. The data in this audit shows $${Math.round(totalActualSpend).toLocaleString()} in total spend — only ${Math.round(deliveryRate * 100)}% of your declared budget. Under-delivery at this scale usually indicates paused campaigns, disapproved ads, limited bids, or audiences that are too small.`,
            evidence: {
              declaredMonthlyBudget: monthlyBudget,
              actualSpendInData: Math.round(totalActualSpend),
              deliveryRatePercent: Math.round(deliveryRate * 100),
            },
            estimatedImpact:
              "Your declared growth targets are being missed by default, before any optimisation work begins.",
            fixSteps: [
              "Check for disapproved ads or policy violations limiting delivery.",
              "Review campaign and ad set statuses — identify everything paused.",
              "Audit bid and budget caps that may be artificially constraining spend.",
              "Broaden audience size if campaigns show 'audience too small' warnings.",
            ],
          })
        );
      }
    }
  }

  // ── A6 (blended CAC): profitability alert when CPA approaches or exceeds CAC ─
  const blendedCac = numberValue(sectionA.blendedCac);
  if (blendedCac > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        const actualCpa = summary.spend / summary.conversions;
        const ratio = actualCpa / blendedCac;
        if (ratio >= 0.9) {
          const isOver = ratio >= 1.0;
          findings.push(
            createFinding({
              ruleId: "BP-PROF-001",
              platform,
              severity: isOver ? "CRITICAL" : "HIGH",
              category: getBiddingCategory(platform),
              title: isOver
                ? `${PLATFORM_LABELS[platform]} ad CPA equals or exceeds your blended CAC — account may be unprofitable`
                : `${PLATFORM_LABELS[platform]} ad CPA is approaching your blended CAC`,
              detail: isOver
                ? `Your declared blended CAC is $${blendedCac}. The current ${PLATFORM_LABELS[platform]} CPA is $${actualCpa.toFixed(2)}, which equals or exceeds what you can sustainably pay per customer across all channels. At this CPA, paid advertising is likely destroying business margin.`
                : `Your declared blended CAC is $${blendedCac}. The current ${PLATFORM_LABELS[platform]} CPA is $${actualCpa.toFixed(2)} — ${Math.round(ratio * 100)}% of your maximum sustainable acquisition cost. A minor performance dip will push the account into unprofitable territory.`,
              evidence: {
                blendedCac,
                actualCpa: Math.round(actualCpa * 100) / 100,
                percentOfCac: Math.round(ratio * 100),
              },
              estimatedImpact: isOver
                ? "Every additional dollar of spend at this CPA deepens the loss per customer."
                : "There is very little headroom before ads become unprofitable.",
              fixSteps: [
                "Immediately pause highest-CPA campaigns and ad sets.",
                "Identify whether the issue is conversion rate (ad/landing page) or CPM efficiency (audience/creative).",
                "Set automated rules to pause ad sets whose 7-day CPA exceeds your blended CAC.",
                "Re-evaluate whether your declared CAC still reflects current business unit economics.",
              ],
            })
          );
        }
      }
    }
  }

  // ── C1 (bestEverCpa): performance regression vs historical best ───────────
  const bestEverCpa = numberValue(sectionC.bestEverCpa);
  if (bestEverCpa > 0) {
    for (const platform of platforms) {
      const summary = getPlatformSummary(dataset, platform);
      if (summary.spend > 0 && summary.conversions > 0) {
        const actualCpa = summary.spend / summary.conversions;
        if (actualCpa > bestEverCpa * 2) {
          findings.push(
            createFinding({
              ruleId: "BP-BENCH-001",
              platform,
              severity: "HIGH",
              category: getBiddingCategory(platform),
              title: `${PLATFORM_LABELS[platform]} CPA is more than 2× your declared best-ever performance`,
              detail: `Your declared best-ever CPA is $${bestEverCpa}. The current ${PLATFORM_LABELS[platform]} CPA is $${actualCpa.toFixed(2)} — ${(actualCpa / bestEverCpa).toFixed(1)}× worse. This level of regression suggests a structural change: audience saturation, creative fatigue, a tracking break, or a platform algorithm shift.`,
              evidence: {
                bestEverCpa,
                actualCpa: Math.round(actualCpa * 100) / 100,
                regressionMultiplier: +(actualCpa / bestEverCpa).toFixed(1),
              },
              estimatedImpact:
                "This level of regression typically requires structural investigation, not just incremental optimisation.",
              fixSteps: [
                "Compare current account structure to the period when best CPA was achieved.",
                "Check for tracking breaks that may be inflating the measured CPA.",
                "Test a simplified structure (fewer campaigns, tighter audiences) to see if performance recovers.",
                "Audit creative: compare current CTR and hook rate to historical benchmarks.",
              ],
            })
          );
        }
      }
    }
  }

  // ── C5: Low landing page conversion rate ─────────────────────────────────
  const landingPageCvr = numberValue(sectionC.landingPageConversionRate);
  if (landingPageCvr > 0 && landingPageCvr < 1.5) {
    for (const platform of platforms) {
      findings.push(
        createFinding({
          ruleId: "BP-BENCH-002",
          platform,
          severity: "HIGH",
          category: getAttributionCategory(platform),
          title: "Landing page conversion rate is low — ad CPA improvements are limited",
          detail: `Your declared landing page conversion rate is ${landingPageCvr}%. At this rate, even ads with excellent CTR and targeting will produce high CPAs because most ad traffic does not convert. Improving the landing page typically delivers faster CPA reductions than optimising the ads themselves.`,
          evidence: { landingPageConversionRate: landingPageCvr },
          estimatedImpact:
            "A 1% improvement in landing page CVR often halves CPA more effectively than months of ad-level optimisation.",
          fixSteps: [
            "Run a CRO audit on the primary landing page — check load speed, above-fold clarity, and CTA prominence.",
            "A/B test a simplified version of the page with a single, clear call to action.",
            "Ensure ad creative messaging matches landing page messaging exactly (message match).",
            "Check page speed with Google PageSpeed Insights — mobile load time above 3s cuts conversion rate significantly.",
          ],
        })
      );
    }
  }
};

const addBenchmarkFindings = ({ audit, dataset, findings }) => {
  const bp = getBusinessProfile(audit);
  const businessType = bp?.sectionA?.businessType || "Other";

  for (const platform of audit.selectedPlatforms) {
    const summary = getPlatformSummary(dataset, platform);
    if (!summary.spend || summary.spend <= 0) continue;

    // CTR benchmark — all three platforms
    const ctrBenchmark = getBenchmark("ctr", platform, businessType);
    if (ctrBenchmark && summary.impressions > 5000) {
      const actualCtr = (summary.clicks / summary.impressions) * 100;
      // Significance: the CTR estimate is reliable above the impression gate.
      const ctrCi = wilsonInterval(summary.clicks, summary.impressions);
      const ctrSignificance = {
        minSamplePassed: summary.impressions >= 1000,
        confidence: summary.impressions >= 5000 ? "high" : "medium",
        sampleNote: `CTR measured over ${summary.impressions.toLocaleString()} impressions`,
        ctrConfidenceInterval: ctrCi
          ? {
              lowPct: +(ctrCi.low * 100).toFixed(3),
              highPct: +(ctrCi.high * 100).toFixed(3),
            }
          : null,
      };
      if (actualCtr < ctrBenchmark.danger) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CTR-001",
            platform,
            severity: "HIGH",
            category: platform === "GOOGLE" ? "Quality Score & Relevance" : "Creative Performance",
            title: `${PLATFORM_LABELS[platform]} CTR is critically below the ${businessType} industry benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} account CTR is ${actualCtr.toFixed(2)}% against an industry benchmark of ${ctrBenchmark.good}% for ${businessType}. A CTR this far below benchmark (danger threshold: ${ctrBenchmark.danger}%) indicates poor creative relevance, weak ad copy, or significant audience-creative mismatch. At your current spend of $${Math.round(summary.spend).toLocaleString()}, you are paying for impressions at an industry-trailing efficiency.`,
            evidence: {
              actualCtr: +actualCtr.toFixed(2),
              benchmarkGood: ctrBenchmark.good,
              benchmarkDanger: ctrBenchmark.danger,
              businessType,
              impressions: summary.impressions,
              ...ctrSignificance,
            },
            estimatedImpact: `Closing the gap from ${actualCtr.toFixed(2)}% to the ${ctrBenchmark.good}% benchmark would deliver significantly more clicks at the same CPM — equivalent to free traffic on your current spend of $${Math.round(summary.spend).toLocaleString()}.`,
            fixSteps: [
              `Test 3–5 new creative concepts with stronger hooks — the ${businessType} benchmark on ${PLATFORM_LABELS[platform]} is ${ctrBenchmark.good}% CTR.`,
              "Audit top-spending ads and pause anything with CTR below half the benchmark.",
              "Tighten audience targeting to improve relevance.",
              platform === "GOOGLE"
                ? "Review ad copy for keyword-to-headline match and strengthen ad extensions."
                : "Test video formats vs. static images — video typically drives higher CTR on this platform.",
            ],
          })
        );
      } else if (actualCtr < ctrBenchmark.warning) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CTR-001",
            platform,
            severity: "MEDIUM",
            category: platform === "GOOGLE" ? "Quality Score & Relevance" : "Creative Performance",
            title: `${PLATFORM_LABELS[platform]} CTR is below the ${businessType} industry benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} account CTR is ${actualCtr.toFixed(2)}%. The industry benchmark for ${businessType} on ${PLATFORM_LABELS[platform]} is ${ctrBenchmark.good}%. You are in the warning zone (below ${ctrBenchmark.warning}%) — creative refresh and audience refinement will improve downstream CPA.`,
            evidence: {
              actualCtr: +actualCtr.toFixed(2),
              benchmarkGood: ctrBenchmark.good,
              benchmarkWarning: ctrBenchmark.warning,
              businessType,
              impressions: summary.impressions,
              ...ctrSignificance,
            },
            estimatedImpact: `Reaching the ${ctrBenchmark.good}% benchmark CTR would reduce your effective CPC without increasing spend.`,
            fixSteps: [
              `Target ${ctrBenchmark.good}% CTR for ${businessType} accounts on ${PLATFORM_LABELS[platform]}.`,
              "Rotate in fresh creative — pause ads running more than 30 days with declining CTR.",
              "Test new audience segments that may be more receptive to your offer.",
            ],
          })
        );
      }
    }

    // CPM benchmark — Meta and TikTok only
    const cpmBenchmark = getBenchmark("cpm", platform, businessType);
    if (cpmBenchmark && summary.impressions > 5000) {
      const actualCpm = (summary.spend / summary.impressions) * 1000;
      const overVsGood = Math.round((actualCpm - cpmBenchmark.good) / 1000 * summary.impressions);
      if (actualCpm > cpmBenchmark.danger) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CPM-001",
            platform,
            severity: "HIGH",
            category: "Audience Strategy",
            title: `${PLATFORM_LABELS[platform]} CPM is critically above the ${businessType} industry benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} CPM is $${actualCpm.toFixed(2)}, which exceeds the danger threshold of $${cpmBenchmark.danger} for ${businessType} accounts. You are overpaying for impressions by an estimated $${overVsGood.toLocaleString()} compared to benchmark-level buying ($${cpmBenchmark.good} CPM target).`,
            evidence: {
              actualCpm: +actualCpm.toFixed(2),
              benchmarkGood: cpmBenchmark.good,
              benchmarkDanger: cpmBenchmark.danger,
              businessType,
              totalSpend: Math.round(summary.spend),
              impressions: summary.impressions,
              estimatedOverspend: overVsGood,
            },
            estimatedImpact: `Overpaying an estimated $${overVsGood.toLocaleString()} vs. benchmark CPM efficiency at your current impression volume.`,
            fixSteps: [
              "Broaden targeting to access cheaper inventory — narrow audiences drive CPM spikes.",
              "Test interest-based and lookalike audiences alongside retargeting (retargeting pools carry premium CPMs).",
              "Review campaign objective — conversion objectives have higher CPMs than traffic or reach objectives.",
              "Audit ad set overlap — overlapping audiences bid against each other and inflate CPM.",
            ],
          })
        );
      } else if (actualCpm > cpmBenchmark.warning) {
        findings.push(
          createFinding({
            ruleId: "BENCH-CPM-001",
            platform,
            severity: "MEDIUM",
            category: "Audience Strategy",
            title: `${PLATFORM_LABELS[platform]} CPM is above the ${businessType} industry benchmark`,
            detail: `Your ${PLATFORM_LABELS[platform]} CPM is $${actualCpm.toFixed(2)}, above the recommended ceiling of $${cpmBenchmark.warning} for ${businessType}. The ideal target is $${cpmBenchmark.good}. This indicates audience or bidding inefficiency.`,
            evidence: {
              actualCpm: +actualCpm.toFixed(2),
              benchmarkGood: cpmBenchmark.good,
              benchmarkWarning: cpmBenchmark.warning,
              businessType,
            },
            estimatedImpact: `Reducing CPM to the $${cpmBenchmark.good} benchmark would extend your reach significantly at the same spend.`,
            fixSteps: [
              "Test broader audiences to access cheaper inventory.",
              "Use the Audience Overlap tool to consolidate competing ad sets.",
              "Test traffic or reach objectives which typically access cheaper inventory than conversion objectives.",
            ],
          })
        );
      }
    }

    // ── DIAG-CPA-001: why is CPA over target? (decomposition) ──────────────
    // Only fires when the customer declared a target CPA and the account has a
    // material, statistically-meaningful sample. Attributes the overage to
    // click cost (low CTR) vs post-click conversion (healthy CTR).
    const targetCpa = numberValue(bp?.sectionA?.targetCpa);
    const conversions = numberValue(summary.conversions);
    if (targetCpa > 0 && conversions > 0) {
      const actualCpa = +(summary.spend / conversions).toFixed(2);
      const actualCtr =
        summary.impressions > 0
          ? +((summary.clicks / summary.impressions) * 100).toFixed(2)
          : null;
      const gate = gateFinding({
        spend: summary.spend,
        clicks: summary.clicks,
        conversions,
        minSpend: 200,
        minClicks: 100,
        minConversions: 10,
        materialSpend: 1000,
      });
      const diagnosis = diagnoseCpaDriver({
        actualCpa,
        targetCpa,
        actualCtr,
        benchmarkCtrWarning: ctrBenchmark?.warning ?? null,
        benchmarkCtrGood: ctrBenchmark?.good ?? null,
      });

      if (gate.surface && diagnosis && diagnosis.dominantDriver !== "unknown") {
        const driverLabel =
          diagnosis.dominantDriver === "conversion_rate"
            ? "weak post-click conversion, not expensive clicks"
            : "expensive, low-relevance clicks";
        findings.push(
          createFinding({
            ruleId: "DIAG-CPA-001",
            platform,
            severity: gate.confidence === "high" ? "HIGH" : "MEDIUM",
            category: getBiddingCategory(platform),
            title: `${PLATFORM_LABELS[platform]} CPA is over target — driven by ${driverLabel}`,
            detail: diagnosis.explanationFacts.join(" "),
            evidence: {
              metric: diagnosis.metric,
              actualCpa,
              targetCpa,
              dominantDriver: diagnosis.dominantDriver,
              driverDeltas: diagnosis.driverDeltas,
              explanationFacts: diagnosis.explanationFacts,
              confidence: gate.confidence,
              minSamplePassed: gate.passed,
              sampleNote: gate.sampleNote,
            },
            estimatedImpact:
              diagnosis.dominantDriver === "conversion_rate"
                ? `CPA is ${diagnosis.driverDeltas.cpaOverTargetPct}% over your $${targetCpa} target. Because CTR is healthy, the highest-leverage fix is post-click: landing page, offer, and conversion tracking — not bids or creative.`
                : `CPA is ${diagnosis.driverDeltas.cpaOverTargetPct}% over your $${targetCpa} target, and low CTR means you are buying expensive, low-relevance clicks. Fix creative/targeting relevance before touching bids.`,
            fixSteps:
              diagnosis.dominantDriver === "conversion_rate"
                ? [
                    "Audit the landing page: load speed, message match, and friction in the conversion step.",
                    "Verify conversion tracking is firing correctly — under-counting inflates CPA.",
                    "Test offer / CTA changes before increasing bids.",
                  ]
                : [
                    "Refresh creative and tighten targeting to lift CTR toward benchmark.",
                    "Pause the lowest-CTR ads carrying meaningful spend.",
                    "Re-check CPA after CTR improves — click cost should fall.",
                  ],
          })
        );
      }
    }
  }
};

const addOpportunityFindings = ({ audit, dataset, findings }) => {
  const bp = getBusinessProfile(audit);
  const sectionA = bp?.sectionA || {};
  const businessType = sectionA.businessType || "Other";
  const monthlyBudget = numberValue(sectionA.monthlyBudget);

  // OPP-001: No Google brand campaign
  if (audit.selectedPlatforms.includes("GOOGLE")) {
    const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
    if (campaigns.length > 0) {
      const hasBrandCampaign = campaigns.some((c) =>
        text(c.name).includes("brand") ||
        text(c.name).includes("branded") ||
        text(c.name).includes("trademark")
      );
      if (!hasBrandCampaign) {
        findings.push(
          createFinding({
            ruleId: "OPP-001",
            platform: "GOOGLE",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "No Google brand campaign detected — brand traffic is unprotected",
            detail: `None of your ${campaigns.length} Google campaign(s) appear to target branded keywords. Without a dedicated brand campaign, competitors can bid on your brand name and capture high-intent searches that should convert at a fraction of your non-brand CPA. Brand campaigns typically achieve 5–10× better CTR and ROAS than non-brand.`,
            evidence: { campaignCount: campaigns.length, brandCampaignDetected: false },
            estimatedImpact: "Unprotected brand searches allow competitors to capture your highest-intent traffic at no cost to you.",
            fixSteps: [
              "Create a dedicated branded keyword campaign with exact and phrase match variants of your brand name.",
              "Set bids high enough to maintain brand impression share above 90%.",
              "Add competitor brand terms to a separate observation campaign to monitor intent traffic.",
            ],
          })
        );
      }
    }
  }

  // OPP-002: eCommerce Google with conversions but zero conversion value
  if (audit.selectedPlatforms.includes("GOOGLE") && businessType === "eCommerce") {
    const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
    if (campaigns.length > 0) {
      const totalConvValue = campaigns.reduce((sum, c) => sum + numberValue(c.convValue), 0);
      const totalConversions = campaigns.reduce((sum, c) => sum + numberValue(c.conversions), 0);
      const totalSpend = campaigns.reduce((sum, c) => sum + numberValue(c.spend), 0);
      if (totalConversions > 0 && totalConvValue === 0) {
        findings.push(
          createFinding({
            ruleId: "OPP-002",
            platform: "GOOGLE",
            severity: "HIGH",
            category: "Conversion Tracking Setup",
            title: "eCommerce account records conversions but no conversion value — ROAS bidding is impossible",
            detail: `Your Google account recorded ${Math.round(totalConversions)} conversions with $0 in conversion value across $${Math.round(totalSpend).toLocaleString()} in spend. Without revenue data flowing into Google Ads, Smart Bidding cannot optimise for ROAS — it defaults to CPA-style optimisation with no understanding of order value. This is a critical gap for any eCommerce account.`,
            evidence: {
              totalConversions: Math.round(totalConversions),
              totalConvValue: 0,
              totalSpend: Math.round(totalSpend),
            },
            estimatedImpact: "Smart Bidding is optimising for count, not revenue — enabling value-based bidding typically improves ROAS 15–30% for eCommerce accounts.",
            fixSteps: [
              "Implement conversion value tracking — pass the transaction revenue amount for every purchase conversion.",
              "Verify the Google Ads purchase tag fires with the correct value parameter on the order confirmation page.",
              "Once value data has 30+ days of history, switch the primary bid strategy to Target ROAS.",
            ],
          })
        );
      }
    }
  }

  // OPP-003: eCommerce Google with no Shopping or Performance Max campaign
  if (audit.selectedPlatforms.includes("GOOGLE") && businessType === "eCommerce") {
    const campaigns = getRecordsByLevel(dataset, "GOOGLE", "campaign");
    if (campaigns.length > 0) {
      const hasShoppingOrPmax = campaigns.some((c) => {
        const t = text(c.type);
        const n = text(c.name);
        return (
          t.includes("shopping") || t.includes("performance_max") || t.includes("pmax") ||
          n.includes("shopping") || n.includes("pmax") || n.includes("performance max")
        );
      });
      if (!hasShoppingOrPmax) {
        findings.push(
          createFinding({
            ruleId: "OPP-003",
            platform: "GOOGLE",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "eCommerce account has no Shopping or Performance Max campaign — major revenue channel missing",
            detail: `Your ${campaigns.length} Google campaign(s) appear entirely Search-based — no Shopping or Performance Max campaigns are detected. For eCommerce, Shopping and PMax campaigns typically drive 40–60% of Google revenue because they show product images and prices directly in search results, capturing high-purchase-intent shoppers at the moment of decision.`,
            evidence: { campaignCount: campaigns.length, shoppingOrPmaxDetected: false },
            estimatedImpact: "Missing Shopping/PMax campaigns leaves a primary eCommerce revenue channel completely untapped.",
            fixSteps: [
              "Ensure your Google Merchant Center feed is verified and approved.",
              "Create a Performance Max campaign with your product feed as the primary asset.",
              "Allocate 15–20% of total Search budget to the initial PMax test.",
              "Review PMax impression share and search term reports after 2–4 weeks.",
            ],
          })
        );
      }
    }
  }

  // OPP-004: Single-platform account with budget sufficient for expansion
  if (audit.selectedPlatforms.length === 1 && monthlyBudget >= 3000) {
    const currentPlatform = audit.selectedPlatforms[0];
    const suggestedPlatform =
      currentPlatform === "META" ? "Google" : currentPlatform === "GOOGLE" ? "Meta" : "Meta";
    findings.push(
      createFinding({
        ruleId: "OPP-004",
        platform: currentPlatform,
        severity: "LOW",
        category: "Campaign Structure",
        title: `Account runs on one platform at $${monthlyBudget.toLocaleString()}/month — ${suggestedPlatform} expansion is a growth lever`,
        detail: `With a declared monthly budget of $${monthlyBudget.toLocaleString()}, this account has the scale to support multi-platform advertising. Single-platform accounts at this budget are exposed to auction volatility and miss audiences only accessible on other platforms.`,
        evidence: { monthlyBudget, currentPlatform, suggestedPlatform },
        estimatedImpact: `Allocating 15–20% of budget to ${suggestedPlatform} diversifies risk and opens new acquisition channels.`,
        fixSteps: [
          `Research ${suggestedPlatform} audience overlap with your current ${PLATFORM_LABELS[currentPlatform]} buyers.`,
          `Start with a 30-day test at $${Math.round(monthlyBudget * 0.15).toLocaleString()}/month on ${suggestedPlatform} — retargeting your existing customer list first.`,
          "Set clear ROAS/CPA targets before launching the test so you have an objective exit criterion.",
        ],
      })
    );
  }

  // OPP-005: Meta with no upper-funnel campaigns (all conversion-objective)
  if (audit.selectedPlatforms.includes("META")) {
    const campaigns = getRecordsByLevel(dataset, "META", "campaign");
    if (campaigns.length >= 3) {
      const upperFunnelObjectives = ["awareness", "reach", "traffic", "engagement", "video_views", "video views"];
      const hasUpperFunnel = campaigns.some((c) =>
        upperFunnelObjectives.some((obj) => text(c.objective).includes(obj))
      );
      const allConversion = campaigns.every((c) => {
        const obj = text(c.objective);
        return obj.includes("conversion") || obj.includes("outcome_sales") || obj.includes("lead") || obj.includes("purchase");
      });
      if (!hasUpperFunnel && allConversion) {
        const totalSpend = sumSpend(campaigns);
        findings.push(
          createFinding({
            ruleId: "OPP-005",
            platform: "META",
            severity: "MEDIUM",
            category: "Campaign Structure",
            title: "All Meta campaigns are conversion-objective — no upper-funnel spend is building future demand",
            detail: `All ${campaigns.length} Meta campaigns run conversion or lead objectives ($${Math.round(totalSpend).toLocaleString()} in detected spend). The account relies entirely on existing market awareness. As audiences saturate, CPAs rise because no fresh awareness traffic feeds the funnel. Retargeting pools shrink and prospecting CPAs climb without upper-funnel investment refreshing them.`,
            evidence: {
              campaignCount: campaigns.length,
              totalSpend: Math.round(totalSpend),
              upperFunnelCampaigns: 0,
            },
            estimatedImpact: "CPAs will continue rising as current audiences saturate without upper-funnel campaigns refreshing the prospecting pool.",
            fixSteps: [
              "Allocate 10–15% of Meta spend to a Reach or Traffic campaign targeting a broad cold audience.",
              "Use this upper-funnel traffic as a retargeting audience for conversion campaigns (30/60/90-day windows).",
              "Test video creative in the awareness campaign — cost-efficient for reach and builds brand recognition.",
            ],
          })
        );
      }
    }
  }

  // OPP-006: High-QS Google keywords with minimal spend (undertapped efficiency)
  if (audit.selectedPlatforms.includes("GOOGLE")) {
    const keywords = getRecordsByLevel(dataset, "GOOGLE", "keyword");
    if (keywords.length > 0) {
      const highQsUnderused = keywords.filter((kw) => {
        const qs = numberValue(kw.qualityScore);
        const clicks = numberValue(kw.clicks);
        const spend = numberValue(kw.spend);
        return qs >= 8 && clicks < 30 && spend < 100;
      });
      if (highQsUnderused.length >= 2) {
        findings.push(
          createFinding({
            ruleId: "OPP-006",
            platform: "GOOGLE",
            severity: "LOW",
            category: "Keyword Strategy",
            title: `${highQsUnderused.length} high-Quality Score keywords are under-budgeted — efficient clicks are being left on the table`,
            detail: `${highQsUnderused.length} keyword(s) have a Quality Score of 8 or above but fewer than 30 clicks and under $100 in spend. High-QS keywords get cheaper CPCs and better ad positions — Google rewards relevance with lower auction prices. Constraining these keywords while spending on lower-QS terms is backwards budget allocation.`,
            evidence: {
              highQsUnderused: highQsUnderused.length,
              examples: highQsUnderused.slice(0, 3).map((kw) => ({
                keyword: kw.keyword,
                qualityScore: kw.qualityScore,
                clicks: kw.clicks,
                spend: kw.spend,
              })),
            },
            estimatedImpact: `Scaling budget to high-QS keywords delivers more clicks at lower CPC than your current keyword mix.`,
            fixSteps: [
              `Identify which campaigns contain the ${highQsUnderused.length} high-QS, low-spend keywords.`,
              "Increase bids or campaign budgets to capture more impression share for these keywords.",
              "Check whether these campaigns are losing impression share to budget constraints.",
            ],
          })
        );
      }
    }
  }
};

const addCompoundFindings = ({ audit, findings }) => {
  // COMP-TRK-001: Three or more tracking failures on the same platform — compound critical
  for (const platform of audit.selectedPlatforms) {
    const trackingFindings = findings.filter(
      (f) =>
        f.platform === platform &&
        (f.ruleId.startsWith("BP-TRK") ||
          f.ruleId.startsWith("TRK") ||
          f.category === getTrackingCategory(platform))
    );

    if (trackingFindings.length >= 3) {
      const alreadyHasCompound = findings.some(
        (f) => f.ruleId === "COMP-TRK-001" && f.platform === platform
      );
      if (!alreadyHasCompound) {
        findings.push(
          createFinding({
            ruleId: "COMP-TRK-001",
            platform,
            severity: "CRITICAL",
            category: getTrackingCategory(platform),
            title: `${PLATFORM_LABELS[platform]} has ${trackingFindings.length} simultaneous tracking failures — all performance data is unreliable`,
            detail: `The audit detected ${trackingFindings.length} independent tracking issues on ${PLATFORM_LABELS[platform]}: ${trackingFindings.map((f) => f.title).join("; ")}. When multiple tracking layers fail simultaneously, every CPA, ROAS, and conversion metric in this report is unreliable. The algorithm is optimising toward false signals — you may be scaling campaigns that are losing money and cutting campaigns that are actually profitable.`,
            evidence: {
              trackingFindingCount: trackingFindings.length,
              affectedRuleIds: trackingFindings.map((f) => f.ruleId),
            },
            estimatedImpact: "CRITICAL: All optimisation decisions on this platform are being made on corrupted data. Fix tracking before acting on any other finding.",
            fixSteps: [
              `Resolve each tracking finding in this report before taking any other action on ${PLATFORM_LABELS[platform]}.`,
              "Install the platform's browser debugging extension and verify events fire on your key conversion pages.",
              "Run a traffic test with UTM parameters and verify the full funnel appears in your analytics.",
              "Consider a dedicated tracking audit before making any bid strategy or budget changes.",
            ],
          })
        );
      }
    }
  }
};

const SEGMENT_CATEGORY = {
  META: "Audience Strategy",
  GOOGLE: "Audience & Attribution",
  TIKTOK: "Audience Strategy",
};

const SEGMENT_WASTE_MIN = 50; // floor before we surface a segment finding

/**
 * SEG-WASTE-001 — dimension-level waste detection.
 *
 * Reads `dataset.data.platforms.<PLATFORM>.byDimension` (age/gender/placement/
 * device/hour/region) when present, computes per-segment CPA vs the platform
 * baseline, and surfaces the single worst significant segment per platform.
 *
 * Safe by construction: when no breakdown data exists (CSV-only audits, or
 * accounts where Meta returned no breakdowns), it emits nothing.
 */
const addSegmentFindings = ({ audit, dataset, findings }) => {
  for (const platform of audit.selectedPlatforms) {
    const platformData = dataset?.data?.platforms?.[platform];
    const byDimension = platformData?.byDimension;
    if (!byDimension || Object.keys(byDimension).length === 0) continue;

    const summary = getPlatformSummary(dataset, platform);
    const baseCpa = baselineCpa({
      spend: summary.spend,
      conversions: summary.conversions,
    });

    // Find the worst significant segment across all available dimensions.
    let worst = null;
    for (const [dimension, records] of Object.entries(byDimension)) {
      if (!Array.isArray(records) || records.length === 0) continue;
      const analysis = analyzeDimension({
        dimension,
        records,
        baselineCpa: baseCpa,
        minSpend: SEGMENT_WASTE_MIN,
      });
      const candidate = analysis.worst;
      if (
        candidate &&
        candidate.wastedSpend >= SEGMENT_WASTE_MIN &&
        (!worst || candidate.wastedSpend > worst.wastedSpend)
      ) {
        worst = candidate;
      }
    }

    if (!worst) continue;

    const platformSpend = summary.spend || 0;
    const wasteShare = platformSpend > 0 ? worst.wastedSpend / platformSpend : 0;
    const severity =
      wasteShare >= 0.3 ? "CRITICAL" : wasteShare >= 0.1 ? "HIGH" : "MEDIUM";

    const wasteStr = `$${Math.round(worst.wastedSpend).toLocaleString()}`;
    const cpaStr = worst.cpa != null ? `$${worst.cpa}` : "no conversions";
    const baseStr = baseCpa != null ? `$${baseCpa}` : "n/a";

    findings.push(
      createFinding({
        ruleId: "SEG-WASTE-001",
        platform,
        severity,
        category: SEGMENT_CATEGORY[platform] || "Audience Strategy",
        title: `The ${worst.segment} ${worst.dimension} segment is wasting ${wasteStr}`,
        detail:
          worst.reason === "zero_conversions"
            ? `The ${worst.segment} ${worst.dimension} segment spent ${wasteStr} with zero conversions vs a platform baseline CPA of ${baseStr}.`
            : `The ${worst.segment} ${worst.dimension} segment runs at ${cpaStr} CPA vs a ${baseStr} platform baseline — ${wasteStr} of that spend is excess cost above baseline efficiency.`,
        evidence: {
          dimension: worst.dimension,
          segment: worst.segment,
          spend: Math.round(worst.spend),
          conversions: worst.conversions,
          segmentCpa: worst.cpa,
          baselineCpa: baseCpa,
          estimatedWaste: Math.round(worst.wastedSpend),
          wasteSharePercent: Number((wasteShare * 100).toFixed(1)),
          reason: worst.reason,
          sampleNote: worst.sampleNote,
        },
        estimatedImpact: `${wasteStr} in this segment is recoverable by reducing or excluding it. Reallocate to segments performing at or below the ${baseStr} baseline CPA.`,
        fixSteps: [
          `Review the ${worst.segment} ${worst.dimension} segment in the platform UI to confirm the underperformance.`,
          `Exclude or down-bid the ${worst.segment} segment if the trend holds over a 7-day window.`,
          "Reallocate the recovered budget to segments at or below baseline CPA.",
        ],
      })
    );
  }
};

const calculateScores = ({ audit, findings }) => {
  const platforms = {};

  for (const platform of audit.selectedPlatforms) {
    const platformFindings = findings.filter((finding) => finding.platform === platform);
    const categoryWeights = PLATFORM_CATEGORIES[platform];
    const categories = {};

    for (const category of Object.keys(categoryWeights)) {
      const categoryFindings = platformFindings.filter(
        (finding) => finding.category === category
      );
      const penalty = categoryFindings.reduce(
        (total, finding) => total + SEVERITY_PENALTIES[finding.severity],
        0
      );

      categories[category] = Math.max(0, 100 - penalty);
    }

    const weightedScore =
      Object.entries(categories).reduce(
        (total, [category, score]) => total + score * categoryWeights[category],
        0
      ) / Object.values(categoryWeights).reduce((total, weight) => total + weight, 0);
    const totalPenalty = platformFindings.reduce(
      (total, finding) => total + SEVERITY_PENALTIES[finding.severity],
      0
    );

    platforms[platform] = {
      score: Math.round(Math.max(0, Math.min(weightedScore, 100 - totalPenalty))),
      categories,
      findingCount: platformFindings.length,
    };
  }

  const overall =
    Object.values(platforms).reduce((total, platform) => total + platform.score, 0) /
    Math.max(1, Object.keys(platforms).length);

  return {
    overall: Math.round(overall),
    platforms,
  };
};

const buildDeterministicSummary = ({ audit, dataset, findings, scores }) => {
  const sortedFindings = [...findings].sort(
    (left, right) =>
      SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
      left.ruleId.localeCompare(right.ruleId)
  );
  const totals = dataset.summary?.totals || {};

  return {
    executiveSummary: [
      `This deterministic audit reviewed ${audit.selectedPlatforms
        .map((platform) => PLATFORM_LABELS[platform])
        .join(", ")} using ${audit.dataSource !== "MANUAL_UPLOAD" ? "live API data" : "validated upload data"} and intake answers.`,
      audit.uploadReadiness?.mode === "FULL"
        ? `Data coverage is complete: all required platform reports were ${audit.dataSource !== "MANUAL_UPLOAD" ? "fetched via OAuth API" : "validated"}.`
        : "Upload readiness is limited: the audit ran with partial data and should be treated as directional until missing reports are uploaded.",
      `The current health score is ${scores.overall}/100. The engine found ${findings.length} issue(s), with ${sortedFindings.filter((finding) => finding.severity === "CRITICAL").length} critical and ${sortedFindings.filter((finding) => finding.severity === "HIGH").length} high-priority item(s).`,
      `Data covers ${totals.uploadedFiles || 0} source(s), ${totals.rowCount || 0} row(s), and ${Math.round(totals.spend || 0).toLocaleString()} in detected spend.`,
    ],
    topPriorities: sortedFindings.slice(0, 5).map((finding) => ({
      ruleId: finding.ruleId,
      platform: finding.platform,
      severity: finding.severity,
      title: finding.title,
      estimatedImpact: finding.estimatedImpact,
    })),
    quickWins: sortedFindings
      .filter((finding) => ["MEDIUM", "LOW"].includes(finding.severity))
      .slice(0, 5)
      .map((finding) => ({
        ruleId: finding.ruleId,
        platform: finding.platform,
        title: finding.title,
        fixSteps: finding.fixSteps,
      })),
  };
};

export const runDeterministicAudit = (audit) => {
  const dataset = audit.normalizedDataset;

  if (!dataset) {
    return {
      findings: [],
      scores: { overall: 0, platforms: {} },
      report: {
        executiveSummary: ["No normalized dataset is available for this audit."],
        topPriorities: [],
        quickWins: [],
      },
    };
  }

  const findings = [];

  if (audit.selectedPlatforms.includes("META")) {
    addMetaFindings({ audit, dataset, findings });
  }
  if (audit.selectedPlatforms.includes("GOOGLE")) {
    addGoogleFindings({ audit, dataset, findings });
  }
  if (audit.selectedPlatforms.includes("TIKTOK")) {
    addTikTokFindings({ audit, dataset, findings });
  }
  addDataQualityFindings({ audit, dataset, findings });
  addBusinessProfileFindings({ audit, dataset, findings });
  addBenchmarkFindings({ audit, dataset, findings });
  addOpportunityFindings({ audit, dataset, findings });
  addSegmentFindings({ audit, dataset, findings });
  addCompoundFindings({ audit, findings });

  const scores = calculateScores({ audit, findings });
  const report = buildDeterministicSummary({ audit, dataset, findings, scores });

  return {
    findings,
    scores,
    report,
  };
};
