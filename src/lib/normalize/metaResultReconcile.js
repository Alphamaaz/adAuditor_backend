/**
 * Ad-set → campaign result reconciliation.
 *
 * Campaign insight rows only carry the campaign OBJECTIVE, a loose signal: an
 * OUTCOME_LEADS campaign whose ad sets actually optimise for CONVERSATIONS is a
 * messaging campaign, but the objective-only resolver tries the `lead` family
 * first and reports a small incidental lead count instead of the real
 * conversation volume (the hiring-campaign undercount: 11 "leads" where Meta
 * records ~98 conversations). Ad-set rows DO carry `optimization_goal` — the
 * authoritative signal for what the spend was actually buying — so when a
 * campaign's ad sets resolve to a different, larger result family, that family
 * wins.
 *
 * Lives in lib/ (not the normalizer) so BOTH paths can apply it:
 *   - pull time, inside buildMetaNormalizedDataset; and
 *   - audit-run time, inside the engine — because audit runs reuse the STORED
 *     dataset and never re-pull, a fix that lived only at pull time would never
 *     reach an already-connected account. Running it at engine time self-heals.
 *
 * Idempotent: re-running on already-reconciled records is a no-op (the campaign
 * family then matches the dominant ad-set family, so nothing changes).
 *
 * Conservative: only overrides when the ad sets cover most of the campaign's
 * spend (a partial ad-set pull can't undercount), the ad-set family genuinely
 * differs from the campaign's pick, and the ad-set count is larger.
 *
 * Pure + deterministic.
 */

const numOr0 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

const cpaFromSpend = (spend, results) =>
  results != null && results > 0 && spend != null ? round2(spend / results) : null;

// Ad sets must account for at least this share of the campaign's spend before we
// trust their family/count over the campaign's own — guards a partial ad-set pull.
export const ADSET_COVERAGE_MIN = 0.8;

export const reconcileCampaignResultsFromAdSets = (campaignRecords, adSetRecords) => {
  if (!Array.isArray(campaignRecords)) return campaignRecords;
  if (!Array.isArray(adSetRecords) || adSetRecords.length === 0) return campaignRecords;

  const byCampaign = new Map();
  for (const a of adSetRecords) {
    if (!a.campaignName) continue;
    const g = byCampaign.get(a.campaignName) || { spend: 0, byFamily: new Map() };
    g.spend += numOr0(a.spend);
    if (a.resultFamily && a.results != null) {
      g.byFamily.set(a.resultFamily, (g.byFamily.get(a.resultFamily) || 0) + numOr0(a.results));
    }
    byCampaign.set(a.campaignName, g);
  }

  return campaignRecords.map((c) => {
    const g = byCampaign.get(c.name);
    if (!g || g.byFamily.size === 0) return c;

    // Dominant ad-set family by reconciled count.
    let famBest = null;
    let famVal = -1;
    for (const [fam, val] of g.byFamily) {
      if (val > famVal) {
        famVal = val;
        famBest = fam;
      }
    }

    const coverage = numOr0(c.spend) > 0 ? g.spend / numOr0(c.spend) : 0;
    if (
      coverage >= ADSET_COVERAGE_MIN &&
      famBest &&
      famBest !== c.resultFamily &&
      famVal > numOr0(c.results)
    ) {
      return {
        ...c,
        results: famVal,
        resultFamily: famBest,
        cpa: cpaFromSpend(c.spend, famVal),
        resultsReconciledFrom: "adset_optimization_goal",
      };
    }
    return c;
  });
};
