import { describe, it, expect } from "vitest";
import { runDeterministicAudit } from "./auditEngine.service.js";
import { buildReportDocumentFromAudit } from "./reportDocument.service.js";
import { renderBlock } from "./premiumReportRenderer.service.js";

/**
 * Parity fixes vs the reference Claude-MCP audit (June 30): text fidelity
 * (hyphens/acronyms survive rendering), the campaign table on single-active
 * accounts, device table level lookup, the tCPA CVR-math diagnosis, remarketing
 * coverage, ad-group naming hygiene, the What's-working section, and
 * cross-finding coherence with the allocation lead finding.
 */

// ── A Google account shaped like the reference: one weak live campaign, proven
// paused winners, device rows, idle user-list audiences, generic ad-group names.
const googleAudit = (overrides = {}) => ({
  id: "aud_parity",
  selectedPlatforms: ["GOOGLE"],
  dataSource: "OAUTH",
  healthScore: 65,
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR" } },
  intakeResponses: [{ section: "PLATFORM_GOOGLE", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 95000, conversions: 700, currency: "PKR" },
      platforms: { GOOGLE: { spend: 95000, conversions: 700, clicks: 35000, impressions: 580000, currency: "PKR" } },
    },
    data: {
      platforms: {
        GOOGLE: {
          records: [],
          byLevel: {
            campaign: [
              // The only live campaign: misses its own tCPA 2× with a CVR far below required.
              { level: "campaign", name: "PK - Display - 6/16", campaignId: "c1", status: "ACTIVE", bidStrategy: "TARGET_CPA", targetCpa: 160, budget: 1500, spend: 19700, clicks: 7800, results: 61, impressions: 114000 },
              // Proven paused winner.
              { level: "campaign", name: "BD | Signals | 6/6", campaignId: "c2", status: "PAUSED", bidStrategy: "TARGET_CPA", targetCpa: 80, spend: 32000, clicks: 10900, results: 380, impressions: 200000 },
              { level: "campaign", name: "IND | Signals | 6/7", campaignId: "c3", status: "PAUSED", bidStrategy: "TARGET_CPA", targetCpa: 95, spend: 18600, clicks: 6650, results: 132, impressions: 150000 },
            ],
            adset: [
              { level: "adset", name: "Ad group 1", campaignName: "PK - Display - 6/16", campaignId: "c1", spend: 19700, results: 61 },
              { level: "adset", name: "Ad group 1", campaignName: "BD | Signals | 6/6", campaignId: "c2", spend: 32000, results: 380 },
              { level: "adset", name: "Ad group 1", campaignName: "IND | Signals | 6/7", campaignId: "c3", spend: 18600, results: 132 },
            ],
            campaign_device: [
              { level: "campaign_device", campaignName: "PK - Display - 6/16", campaignId: "c1", device: "MOBILE", spend: 19000, clicks: 7300, conversions: 61 },
              { level: "campaign_device", campaignName: "PK - Display - 6/16", campaignId: "c1", device: "DESKTOP", spend: 660, clicks: 250, conversions: 0 },
              { level: "campaign_device", campaignName: "IND | Signals | 6/7", campaignId: "c3", device: "TABLET", spend: 340, clicks: 120, conversions: 6 },
            ],
            // User-list (remarketing) audiences exist but only on a zero-spend campaign.
            audience: [
              { level: "audience", status: "ACTIVE", campaignId: "c9", campaignName: "BD | YT – old", criterionId: "111", userListResourceName: "customers/1/userLists/9" },
            ],
            audience_performance: [
              { level: "audience_performance", campaignId: "c2", campaignName: "BD | Signals | 6/6", criterionId: "222", audienceType: "CUSTOM_AUDIENCE", audienceLabel: "BD New Audience", spend: 32000, clicks: 10900, conversions: 380 },
            ],
          },
          byDimension: {},
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
  ...overrides,
});

const findingsOf = (audit) => runDeterministicAudit(audit).findings;

describe("tCPA finding does the CVR math instead of guessing", () => {
  const findings = findingsOf(googleAudit());
  const bid = findings.find((f) => f.ruleId === "GOOGLE-BID-002");

  it("fires with the required-vs-actual CVR arithmetic in the narrative", () => {
    expect(bid).toBeDefined();
    // CPC ≈ 2.53, needed CVR ≈ 1.58%, actual ≈ 0.78% → CVR diagnosis branch.
    expect(bid.detail).toMatch(/conversion rate/i);
    expect(bid.detail).toMatch(/cannot support this target/i);
    expect(bid.detail).not.toMatch(/one of three things/i);
    expect(bid.evidence.requiredCvrPercent).toBeGreaterThan(0);
    expect(bid.evidence.actualCvrPercent).toBeGreaterThan(0);
  });

  it("does not tell the client to just raise the target when CVR is the constraint", () => {
    expect(bid.fixSteps.join(" ")).toMatch(/conversion side|post-click|funnel/i);
  });
});

describe("cross-finding coherence with the allocation lead finding", () => {
  const findings = findingsOf(googleAudit());

  it("prefixes findings on the pause candidate with the lead-finding note", () => {
    const alloc = findings.find((f) => f.ruleId === "GOOGLE-ALLOC-001");
    expect(alloc).toBeDefined();
    const bid = findings.find((f) => f.ruleId === "GOOGLE-BID-002");
    expect(bid.fixSteps[0]).toMatch(/lead finding/i);
    expect(bid.fixSteps[0]).toContain("PK - Display - 6/16");
  });

  it("makes the allocation cut recommendation budget-specific", () => {
    const alloc = findings.find((f) => f.ruleId === "GOOGLE-ALLOC-001");
    expect(alloc.fixSteps.join(" ")).toMatch(/PKR 1,500\/day/);
  });
});

describe("OPP-RMK-001 — remarketing coverage", () => {
  it("fires when user lists exist but nothing live uses them", () => {
    const f = findingsOf(googleAudit()).find((x) => x.ruleId === "OPP-RMK-001");
    expect(f).toBeDefined();
    expect(f.detail).toMatch(/already built/i);
    expect(f.evidence.advisory).toBe(true);
  });

  it("stays silent when a spending campaign runs a user-list audience", () => {
    const audit = googleAudit();
    audit.normalizedDataset.data.platforms.GOOGLE.byLevel.audience.push({
      level: "audience", status: "ACTIVE", campaignId: "c1", campaignName: "PK - Display - 6/16",
      criterionId: "333", userListResourceName: "customers/1/userLists/10",
    });
    expect(findingsOf(audit).find((x) => x.ruleId === "OPP-RMK-001")).toBeUndefined();
  });

  it("stays silent when the audience grain was not pulled (absence unverifiable)", () => {
    const audit = googleAudit();
    audit.normalizedDataset.data.platforms.GOOGLE.byLevel.audience = [];
    audit.normalizedDataset.data.platforms.GOOGLE.byLevel.audience_performance = [];
    expect(findingsOf(audit).find((x) => x.ruleId === "OPP-RMK-001")).toBeUndefined();
  });
});

describe("GOOGLE-HYGIENE-002 — default ad-group names", () => {
  it("flags spending ad groups still named 'Ad group 1'", () => {
    const f = findingsOf(googleAudit()).find((x) => x.ruleId === "GOOGLE-HYGIENE-002");
    expect(f).toBeDefined();
    expect(f.severity).toBe("LOW");
    expect(f.title).toMatch(/3 of 3/);
  });

  it("stays silent when ad groups are properly named", () => {
    const audit = googleAudit();
    for (const g of audit.normalizedDataset.data.platforms.GOOGLE.byLevel.adset) {
      g.name = `Named | ${g.campaignName}`;
    }
    expect(findingsOf(audit).find((x) => x.ruleId === "GOOGLE-HYGIENE-002")).toBeUndefined();
  });
});

describe("report document — parity sections", () => {
  const audit = googleAudit();
  const { findings } = runDeterministicAudit(audit);
  const doc = buildReportDocumentFromAudit({ ...audit, ruleFindings: findings });

  it("renders the campaign table even with a single active campaign (paused ones included)", () => {
    const dd = doc.sections.find((s) => s.id === "campaign-deep-dive");
    expect(dd).toBeDefined();
    expect(dd.blocks[0].rows.length).toBe(3);
    // Bidding column carries the tCPA setting.
    const pk = dd.blocks[0].rows.find((r) => r[0] === "PK - Display - 6/16");
    expect(pk[1]).toBe("tCPA PKR 160");
  });

  it("renders the device table from campaign_device records", () => {
    const dev = doc.sections.find((s) => s.id === "device-breakdown");
    expect(dev).toBeDefined();
    const flat = JSON.stringify(dev.blocks[0].rows);
    expect(flat).toContain("DESKTOP");
  });

  it("renders What's-working with the paused winner named", () => {
    const w = doc.sections.find((s) => s.id === "whats-working");
    expect(w).toBeDefined();
    const flat = JSON.stringify(w.blocks[0].rows);
    expect(flat).toContain("BD | Signals | 6/6");
    expect(flat).toMatch(/proven winner, currently paused/);
  });

  it("uses a specific impact chip for the tCPA finding, not a vague bucket", () => {
    const table = doc.sections.find((s) => s.id === "findings").blocks[0];
    const bidRow = table.rows.find((r) => /Target CPA/.test(r[1]));
    expect(bidRow[3]).toMatch(/% over target/);
  });
});

// ── A Meta account shaped like the reference FxTrader audit: one campaign with
// implausibly cheap conversions (the WhatsApp click-as-lead anomaly), real
// lead-gen campaigns around PKR 104–143, placement/adset grains, dormant dead
// campaigns with configured budgets.
const metaAudit = () => ({
  id: "aud_meta_parity",
  selectedPlatforms: ["META"],
  dataSource: "OAUTH",
  healthScore: 79,
  businessProfileSnapshot: { sectionA: { businessType: "Lead Gen", currency: "PKR", targetCpa: 40 } },
  intakeResponses: [{ section: "PLATFORM_META", answers: {} }],
  uploadReadiness: { mode: "FULL" },
  normalizedDataset: {
    summary: {
      totals: { spend: 258000, conversions: 4640, currency: "PKR" },
      platforms: { META: { spend: 258000, conversions: 4640, clicks: 30000, impressions: 500000, currency: "PKR" } },
    },
    data: {
      platforms: {
        META: {
          records: [],
          byLevel: {
            campaign: [
              { level: "campaign", name: "alt Testing phasenew whatsapp", status: "ACTIVE", objective: "OUTCOME_LEADS", bidStrategy: "LOWEST_COST_WITHOUT_CAP", spend: 37613, budget: 150000, clicks: 11551, impressions: 49111, results: 2730, cpa: 13.78, cpm: 765, ctr: 23.5, frequency: 1.51, resultFamily: "lead" },
              { level: "campaign", name: "alt Testing phase 2 | bot", status: "ACTIVE", objective: "OUTCOME_LEADS", bidStrategy: "LOWEST_COST_WITHOUT_CAP", spend: 101812, budget: 400000, clicks: 7145, impressions: 194000, results: 915, cpa: 111.3, cpm: 525, frequency: 3.24, resultFamily: "lead" },
              { level: "campaign", name: "alt Testing phase 3 | new videos", status: "ACTIVE", objective: "OUTCOME_LEADS", bidStrategy: "LOWEST_COST_WITHOUT_CAP", spend: 62116, budget: 400000, clicks: 7290, impressions: 190000, results: 597, cpa: 104.05, cpm: 326, frequency: 2.16, resultFamily: "lead" },
              { level: "campaign", name: "alt Testing phase 4th testing – new –lp single cr", status: "ACTIVE", objective: "OUTCOME_LEADS", bidStrategy: "LOWEST_COST_WITHOUT_CAP", spend: 49624, budget: 200000, clicks: 2298, impressions: 56000, results: 348, cpa: 142.6, cpm: 886, frequency: 1.96, resultFamily: "lead" },
            ],
            adset: [
              { level: "adset", name: "New Leads ad set", campaignName: "alt Testing phase 3 | new videos", spend: 38790, results: 350, frequency: 1.85, impressions: 126000 },
              { level: "adset", name: "interest", campaignName: "alt Testing phase 3 | new videos", spend: 13251, results: 157, frequency: 1.43, impressions: 36600 },
              { level: "adset", name: "New Leads ad set", campaignName: "alt Testing phase 2 | bot", spend: 69087, results: 637, frequency: 2.95, impressions: 148000 },
              { level: "adset", name: "interest", campaignName: "alt Testing phase 2 | bot", spend: 45707, results: 385, frequency: 2.06, impressions: 63000 },
              { level: "adset", name: "New Leads ad set", campaignName: "alt Testing phasenew whatsapp", spend: 37613, results: 2730, frequency: 1.51, impressions: 49111 },
            ],
            ad: [
              { level: "ad", name: "New Leads ad – Copy 2", campaignName: "alt Testing phase 3 | new videos", spend: 30000, results: 280 },
              { level: "ad", name: "New Leads ad – Copy 5", campaignName: "alt Testing phase 3 | new videos", spend: 32000, results: 317 },
              { level: "ad", name: "New Leads ad", campaignName: "alt Testing phase 2 | bot", spend: 60000, results: 530 },
              { level: "ad", name: "New Leads ad – Copy 6", campaignName: "alt Testing phase 2 | bot", spend: 41000, results: 385 },
            ],
            campaignStructureOnly: [
              { level: "campaign", name: "QX testing | old", status: "PAUSED", spend: 0, impressions: 0, budget: 200000, neverDelivered: true },
              { level: "campaign", name: "DNU ig msgs | Azeen", status: "PAUSED", spend: 0, impressions: 0, budget: 150000, neverDelivered: true },
              { level: "campaign", name: "lucky draw test", status: "PAUSED", spend: 0, impressions: 0, budget: 100000, neverDelivered: true },
            ],
          },
          byDimension: {
            placement: [
              { dimension: "placement", segment: "facebook", spend: 166370, clicks: 15209, results: 1459, conversions: 1459, impressions: 357428 },
              { dimension: "placement", segment: "instagram", spend: 54317, clicks: 2215, results: 442, conversions: 442, impressions: 93460 },
              { dimension: "placement", segment: "audience_network", spend: 37389, clicks: 11484, results: 2712, conversions: 2712, impressions: 48441 },
            ],
          },
          byDay: [],
          currency: "PKR",
        },
      },
    },
  },
});

describe("Meta parity — anomaly-aware sections and score", () => {
  const audit = metaAudit();
  const { findings, scores } = runDeterministicAudit(audit);
  const anomaly = findings.find((f) => f.ruleId === "TRACK-ANOMALY-001");
  const doc = buildReportDocumentFromAudit({ ...audit, ruleFindings: findings, healthScore: scores.overall });

  it("detects the too-cheap-to-be-genuine campaign", () => {
    expect(anomaly).toBeDefined();
    expect(anomaly.severity).toBe("CRITICAL");
  });

  it("caps the platform score below the Good band when conversion data is unverified", () => {
    expect(scores.platforms.META.score).toBeLessThanOrEqual(55);
  });

  it("floors a category carrying a CRITICAL finding at 40", () => {
    const categories = scores.platforms.META.categories;
    const anomalyCategory = categories[anomaly.category];
    expect(anomalyCategory).toBeLessThanOrEqual(40);
  });

  it("excludes the anomaly campaign from the funnel table and its target override", () => {
    const funnel = doc.sections.find((s) => s.id === "funnel-cvr");
    expect(funnel).toBeDefined();
    const flat = JSON.stringify(funnel.blocks[0].rows);
    expect(flat).not.toContain("whatsapp");
    // With the fake PKR 14 CPA excluded, the PKR 40 target is below every real
    // campaign's achieved CPA → measured against the achievable bar instead.
    expect(funnel.intro).toMatch(/achievable/i);
    expect(funnel.blocks[0].footnote).toMatch(/too cheap to be genuine/i);
  });

  it("renders the placement table with the anomaly caveat on the too-cheap row", () => {
    const placement = doc.sections.find((s) => s.id === "placement-breakdown");
    expect(placement).toBeDefined();
    const an = placement.blocks[0].rows.find((r) => /audience network/i.test(r[0]));
    expect(an).toBeDefined();
    expect(an[6]).toMatch(/unverified/i);
  });

  it("renders the ad-set table and names the best ad set", () => {
    const adsets = doc.sections.find((s) => s.id === "adset-breakdown");
    expect(adsets).toBeDefined();
    const flat = JSON.stringify(adsets.blocks[0].rows);
    expect(flat).toMatch(/Best ad set — protect/);
  });

  it("caveats a What's-working winner that carries an open finding", () => {
    const working = doc.sections.find((s) => s.id === "whats-working");
    expect(working).toBeDefined();
    const phase2 = working.blocks[0].rows.find((r) => /phase 2 \| bot/.test(r[0]));
    if (phase2) expect(phase2[2]).toMatch(/But note: it/);
  });

  it("prices the ghost-budget pool on the dead-campaign finding (minor units → major)", () => {
    const dead = findings.find((f) => f.ruleId === "META-HYGIENE-002");
    expect(dead).toBeDefined();
    // 200000 + 150000 + 100000 minor units = PKR 4,500/day
    expect(dead.evidence.dormantDailyBudget).toBe(4500);
    expect(dead.detail).toMatch(/dormant spend authority/);
  });

  it("never promotes the dormant-budget RISK figure to recoverable money", () => {
    // The PKR/day a misclick COULD start spending is not recovered by archiving
    // — report 21 wrongly headlined it "PKR 49,800 recoverable this period".
    const dead = findings.find((f) => f.ruleId === "META-HYGIENE-002");
    expect(dead.evidence.advisory).toBe(true);
    expect(dead.evidence.netRecoverable).toBe(0);
    // With no genuine quantified leak on this account, the headline must say so
    // instead of projecting the ghost budget quarterly/annually.
    expect(doc.key_numbers[0].value).toBe("No quantified leak");
    expect(doc.sections.find((s) => s.id === "money-map")).toBeUndefined();
  });

  it("sets the funnel's achievable bar from proven volume, not a thin side campaign", () => {
    const funnel = doc.sections.find((s) => s.id === "funnel-cvr");
    // Best proven (≥20 conversions, non-anomaly) campaign is phase 3 at PKR 104.
    expect(funnel.intro).toContain("PKR 104");
  });

  it("recommends creative diversity when campaigns run ≤2 ads", () => {
    const creative = doc.sections.find((s) => s.id === "creative-copy");
    expect(creative).toBeDefined();
    const flat = JSON.stringify(creative.blocks[0].rows);
    expect(flat).toMatch(/Creative diversity/);
    expect(flat).toMatch(/default\/copy names/);
  });

  it("does not truncate the masthead mid-word", () => {
    expect(doc.masthead.headline).not.toMatch(/\S{1,3}$/.test(doc.masthead.headline) && / \S{1,2}$/);
    if (doc.masthead.headline.endsWith("…")) {
      expect(doc.masthead.headline).not.toMatch(/\s\S{1,2}…$/);
    }
  });
});

describe("renderer count-vs-money labels", () => {
  it("renders a count evidence row as a number, not currency", () => {
    const html = renderBlock({
      type: "evidence_table",
      currency: "PKR",
      rows: [{ metric: "spendingAdSets", value: 11 }],
    });
    expect(html).toContain(">11<");
    expect(html).not.toContain("PKR 11");
  });
});

describe("renderer text fidelity", () => {
  it("keeps hyphens, minus signs, and acronym casing in prose", () => {
    const html = renderBlock({
      type: "callout",
      text: "Re-enable the winner; set a -100% desktop modifier. The CVR and CTA both matter post-click. Cross-check the CRM.",
    });
    expect(html).toContain("Re-enable");
    expect(html).toContain("-100%");
    expect(html).toContain("CVR");
    expect(html).toContain("CTA");
    expect(html).toContain("CRM");
    expect(html).toContain("post-click");
  });

  it("does not lowercase prose labels in evidence-table fallbacks", () => {
    const html = renderBlock({
      type: "bar_chart_h",
      currency: "PKR",
      rows: [
        { label: "The Thursday day-of-week segment is wasting PKR 3,990", value: 3990, max: 14608, display: "PKR 3,990" },
        { label: "The account is live on a weaker campaign", value: 14608, max: 14608, display: "PKR 14,608" },
      ],
    });
    expect(html).toContain("Thursday");
    expect(html).not.toContain("thursday");
    expect(html).toContain("PKR 3,990");
    expect(html).toContain("<th>Finding</th>");
  });
});
