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

const toArray = (value) => (Array.isArray(value) ? value : value ? [value] : []);

const text = (value) => String(value || "").toLowerCase();

const includesAny = (value, terms) => {
  const values = toArray(value).map(text);
  return terms.some((term) => values.some((valueItem) => valueItem.includes(term)));
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

  if (text(answers.M6).includes("no") || text(answers.M6).includes("unsure")) {
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

  if (text(answers.M5).startsWith("no")) {
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
          },
          estimatedImpact: "Higher CPMs and weaker reach efficiency.",
          fixSteps: [
            "Pause ads with multiple below-average rankings.",
            "Iterate on hooks, formats, and visual quality for retained creative.",
            "Run a fresh creative test focused on the weakest dimension.",
          ],
        })
      );
    }
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

  if (includesAny(answers.G11, ["no"])) {
    findings.push(
      createFinding({
        ruleId: "TRK-007",
        platform: "GOOGLE",
        severity: "HIGH",
        category: "Conversion Tracking Setup",
        title: "Enhanced Conversions are not configured",
        detail: "Enhanced Conversions improve conversion signal quality for Google Ads.",
        evidence: { G11: answers.G11 },
        estimatedImpact: "Can reduce smart bidding signal quality.",
        fixSteps: [
          "Configure Enhanced Conversions for primary conversion actions.",
          "Verify diagnostics in Google Ads conversion settings.",
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

  if (includesAny(answers.G5, ["no", "never"])) {
    findings.push(
      createFinding({
        ruleId: "KW-001",
        platform: "GOOGLE",
        severity: "CRITICAL",
        category: "Keyword Strategy",
        title: "No negative keyword process is confirmed",
        detail: "Missing negative keywords can create avoidable search waste.",
        evidence: { G5: answers.G5 },
        estimatedImpact: "Can waste spend on irrelevant search queries.",
        fixSteps: [
          "Create shared negative keyword lists.",
          "Review search terms weekly for active campaigns.",
          "Separate brand protection from generic negatives.",
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

  if (text(answers.G8).includes("no") || text(answers.G8).includes("unsure")) {
    findings.push(
      createFinding({
        ruleId: "AUD-006",
        platform: "GOOGLE",
        severity: "MEDIUM",
        category: "Audience & Attribution",
        title: "Audience observation layers are not confirmed",
        detail: "Observation audiences help identify high-value segments without restricting reach.",
        evidence: { G8: answers.G8 },
        estimatedImpact: "Missed segmentation and bid-adjustment insight.",
        fixSteps: ["Add relevant remarketing and customer segments in observation mode."],
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
            estimatedImpact:
              "Likely overspend on irrelevant queries; auditing search terms usually reveals significant waste.",
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
            estimatedImpact:
              "Higher CPCs and reduced auction competitiveness on a meaningful chunk of spend.",
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
          estimatedImpact:
            "Adding high-spend non-converting terms as negatives can recapture meaningful budget.",
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

  if (text(answers.T8).includes("no") || text(answers.T8).includes("unsure")) {
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
          estimatedImpact:
            "Low CTR usually means high CPM-to-conversion ratio; reallocating to stronger creative typically lifts ROAS.",
          fixSteps: [
            "Pause the lowest-CTR ads and shift budget to top performers.",
            "Test stronger 1-3 second hooks on remaining ads.",
            "Iterate on creator, format, and pattern interrupts.",
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
        .join(", ")} using validated upload data and intake answers.`,
      audit.uploadReadiness?.mode === "FULL"
        ? "Upload readiness is full: all required platform reports were validated."
        : "Upload readiness is limited: the audit ran with partial data and should be treated as directional until missing reports are uploaded.",
      `The current health score is ${scores.overall}/100. The engine found ${findings.length} issue(s), with ${sortedFindings.filter((finding) => finding.severity === "CRITICAL").length} critical and ${sortedFindings.filter((finding) => finding.severity === "HIGH").length} high-priority item(s).`,
      `Uploaded data currently covers ${totals.uploadedFiles || 0} file(s), ${totals.rowCount || 0} row(s), and ${Math.round(totals.spend || 0).toLocaleString()} in detected spend.`,
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

  const scores = calculateScores({ audit, findings });
  const report = buildDeterministicSummary({ audit, dataset, findings, scores });

  return {
    findings,
    scores,
    report,
  };
};
