/**
 * Audit comparison — peer matching + self-over-time deltas.
 *
 * Pure, deterministic. The LLM never computes deltas; it narrates the facts
 * this module produces.
 *
 * Two comparison modes:
 *   - selfOverTime: current audit vs the most recent prior audit of the SAME
 *     ad account.
 *   - peer: current audit vs the most relevant DIFFERENT same-org account
 *     (same platform, similar business type + spend band).
 *
 * Inputs are "snapshots" — a flat shape both the live audit and stored memory
 * summaries normalize to (see normalizeSnapshotFromMemory).
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const round = (n, dp = 2) =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp;

const pctDelta = (current, previous) => {
  const c = num(current);
  const p = num(previous);
  if (p === 0) return null;
  return round(((c - p) / p) * 100, 1);
};

export const deriveKpis = ({ spend, impressions, clicks, conversions, revenue } = {}) => {
  const s = num(spend);
  const imp = num(impressions);
  const clk = num(clicks);
  const cv = num(conversions);
  const rev = revenue != null ? num(revenue) : null;
  return {
    ctr: imp > 0 ? round((clk / imp) * 100, 3) : null, // %
    cpc: clk > 0 ? round(s / clk, 2) : null,
    cpa: cv > 0 ? round(s / cv, 2) : null,
    cpm: imp > 0 ? round((s / imp) * 1000, 2) : null,
    roas: rev != null && s > 0 ? round(rev / s, 2) : null,
  };
};

export const spendBand = (spend) => {
  const s = num(spend);
  if (s < 1000) return "0-1k";
  if (s < 10000) return "1k-10k";
  if (s < 100000) return "10k-100k";
  return "100k+";
};

/**
 * Normalize a stored memory summary (any schemaVersion) into a snapshot.
 * Backward compatible: older summaries lack kpis/adAccountId — we derive what
 * we can and default the rest.
 */
export const normalizeSnapshotFromMemory = (summary = {}) => {
  const totals = summary.spendTotals || {};
  const spend = num(summary.spend ?? totals.total);
  const platforms = summary.selectedPlatforms || [];
  // KPIs: prefer stored kpis (v3+), else derive from any stored aggregates.
  const kpis =
    summary.kpis ||
    deriveKpis({
      spend,
      impressions: summary.impressions,
      clicks: summary.clicks,
      conversions: summary.conversions,
    });
  return {
    auditId: summary.auditId || null,
    adAccountId: summary.adAccountId || null,
    adAccountName: summary.adAccountName || null,
    completedAt: summary.completedAt || null,
    platforms,
    primaryPlatform: platforms[0] || null,
    businessType: summary.businessType || summary.businessProfile?.businessType || null,
    spend,
    impressions: num(summary.impressions),
    clicks: num(summary.clicks),
    conversions: num(summary.conversions),
    kpis,
    healthScore: summary.healthScore ?? null,
    criticalRuleIds: summary.criticalRuleIds || [],
    schemaVersion: summary.schemaVersion || 1,
  };
};

/**
 * Choose the most relevant peer from candidate snapshots. Hard requirement:
 * same primary platform and a different ad account. Scored on businessType +
 * spend band similarity. Returns { peer, score, reasons } or null.
 */
export const pickPeer = ({ current, candidates = [] }) => {
  const eligible = candidates.filter(
    (c) =>
      c &&
      c.primaryPlatform &&
      current.primaryPlatform &&
      c.primaryPlatform === current.primaryPlatform &&
      c.adAccountId &&
      c.adAccountId !== current.adAccountId
  );
  if (eligible.length === 0) return null;

  const curBand = spendBand(current.spend);
  const scored = eligible.map((c) => {
    let score = 0;
    const reasons = ["same platform"];
    if (c.businessType && current.businessType && c.businessType === current.businessType) {
      score += 2;
      reasons.push("same business type");
    }
    if (spendBand(c.spend) === curBand) {
      score += 1;
      reasons.push("similar spend band");
    }
    return { peer: c, score, reasons };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tie-break: most recent completedAt.
    return (
      new Date(b.peer.completedAt || 0).getTime() -
      new Date(a.peer.completedAt || 0).getTime()
    );
  });

  return scored[0];
};

/**
 * Compare current vs a peer snapshot. Returns metric deltas + the strongest
 * underperformance gap + a confidence note based on impression sample.
 */
export const peerComparison = ({ current, peer }) => {
  if (!current || !peer) return null;
  const c = current.kpis || {};
  const p = peer.kpis || {};

  const deltas = {
    ctrPct: pctDelta(c.ctr, p.ctr),
    cpaPct: pctDelta(c.cpa, p.cpa),
    cpcPct: pctDelta(c.cpc, p.cpc),
    cpmPct: pctDelta(c.cpm, p.cpm),
    roasPct: pctDelta(c.roas, p.roas),
    spendPct: pctDelta(current.spend, peer.spend),
    conversionsPct: pctDelta(current.conversions, peer.conversions),
  };

  // Underperformance: lower CTR/ROAS is worse; higher CPA/CPC is worse.
  const gaps = [];
  if (c.ctr != null && p.ctr != null && c.ctr < p.ctr) {
    gaps.push({ metric: "CTR", current: c.ctr, peer: p.ctr, worseByPct: pctDelta(p.ctr, c.ctr) });
  }
  if (c.cpa != null && p.cpa != null && c.cpa > p.cpa) {
    gaps.push({ metric: "CPA", current: c.cpa, peer: p.cpa, worseByPct: pctDelta(c.cpa, p.cpa) });
  }
  if (c.roas != null && p.roas != null && c.roas < p.roas) {
    gaps.push({ metric: "ROAS", current: c.roas, peer: p.roas, worseByPct: pctDelta(p.roas, c.roas) });
  }
  gaps.sort((a, b) => (b.worseByPct || 0) - (a.worseByPct || 0));

  const enoughSample = current.impressions >= 5000 && peer.impressions >= 5000;
  return {
    peer: {
      auditId: peer.auditId,
      adAccountName: peer.adAccountName,
      completedAt: peer.completedAt,
      businessType: peer.businessType,
    },
    deltas,
    strongestGap: gaps[0] || null,
    confidence: enoughSample ? "high" : "low",
    sampleNote: enoughSample
      ? "both accounts have sufficient impression volume"
      : "limited impression volume — treat as directional",
  };
};

/**
 * Self-over-time delta: current vs previous (same ad account). Includes
 * finding-level resolution analysis using stored criticalRuleIds.
 */
export const memoryDelta = ({ current, previous }) => {
  if (!current || !previous) return null;
  const c = current.kpis || {};
  const p = previous.kpis || {};

  const prevCriticals = new Set(previous.criticalRuleIds || []);
  const curCriticals = new Set(current.criticalRuleIds || []);
  const resolvedCriticals = [...prevCriticals].filter((id) => !curCriticals.has(id));
  const newCriticals = [...curCriticals].filter((id) => !prevCriticals.has(id));
  const repeatedCriticals = [...curCriticals].filter((id) => prevCriticals.has(id));

  return {
    previousAuditId: previous.auditId,
    previousCompletedAt: previous.completedAt,
    healthScoreDelta:
      current.healthScore != null && previous.healthScore != null
        ? round(current.healthScore - previous.healthScore, 1)
        : null,
    deltas: {
      ctrPct: pctDelta(c.ctr, p.ctr),
      cpaPct: pctDelta(c.cpa, p.cpa),
      cpcPct: pctDelta(c.cpc, p.cpc),
      roasPct: pctDelta(c.roas, p.roas),
      spendPct: pctDelta(current.spend, previous.spend),
      conversionsPct: pctDelta(current.conversions, previous.conversions),
    },
    resolvedCriticals,
    newCriticals,
    repeatedCriticals,
  };
};

/**
 * Convenience: from a current snapshot + prior snapshots, return both
 * comparison fact blocks for the evidence packet. No findings, no prose.
 */
export const buildComparisonFacts = ({ current, priorSnapshots = [] }) => {
  const sameAccount = priorSnapshots
    .filter((s) => s.adAccountId && s.adAccountId === current.adAccountId)
    .sort(
      (a, b) =>
        new Date(b.completedAt || 0).getTime() -
        new Date(a.completedAt || 0).getTime()
    );
  const previous = sameAccount[0] || null;
  const peerPick = pickPeer({ current, candidates: priorSnapshots });

  return {
    selfOverTime: previous ? memoryDelta({ current, previous }) : null,
    peer: peerPick ? peerComparison({ current, peer: peerPick.peer }) : null,
    peerMatchReasons: peerPick ? peerPick.reasons : null,
  };
};

export const __test__ = { pctDelta, round, num };
