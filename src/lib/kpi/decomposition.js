/**
 * KPI decomposition — express a headline metric as the product of its drivers,
 * then attribute how much each driver contributes to the result.
 *
 * This is the "CPR is CTR-driven, not CPM-driven" capability. Pure code —
 * the LLM never computes these; it narrates the output.
 *
 * Identities used (per-1000-impression basis):
 *   CTR  = clicks / impressions
 *   CVR  = conversions / clicks            (click→result rate)
 *   CPM  = spend / impressions * 1000
 *   CPC  = spend / clicks                  = CPM / (CTR*1000)... derived from raw
 *   CPA  = spend / conversions             = CPC / CVR = CPM / (1000*CTR*CVR)
 *   ROAS = revenue / spend                 = (AOV * conversions) / spend
 */

const safeDiv = (num, den) =>
  den && Number.isFinite(num / den) ? num / den : null;

const round = (n, dp = 4) =>
  n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Compute the base metrics from raw totals.
 * @param {{spend,impressions,clicks,conversions,revenue?}} t
 */
export const baseMetrics = (t = {}) => {
  const spend = Number(t.spend) || 0;
  const impressions = Number(t.impressions) || 0;
  const clicks = Number(t.clicks) || 0;
  const conversions = Number(t.conversions) || 0;
  const revenue = Number(t.revenue) || null;

  return {
    spend,
    impressions,
    clicks,
    conversions,
    ctr: round(safeDiv(clicks, impressions)),
    cvr: round(safeDiv(conversions, clicks)),
    cpm: round(safeDiv(spend, impressions) != null ? (spend / impressions) * 1000 : null, 2),
    cpc: round(safeDiv(spend, clicks), 2),
    cpa: round(safeDiv(spend, conversions), 2),
    roas: revenue != null ? round(safeDiv(revenue, spend), 2) : null,
  };
};

/**
 * Decompose CPA (or CPR) into CPM, CTR, CVR drivers and attribute each
 * driver's contribution to the gap vs a reference (peer/benchmark/best).
 *
 * Contribution is computed in log space so a product identity splits
 * additively: ln(CPA) = ln(CPM) - ln(1000) - ln(CTR) - ln(CVR).
 * The percentages describe how much of the ln(actual/reference) gap each
 * driver explains.
 *
 * @param {object} actual     base metrics of the account/segment
 * @param {object} [reference] base metrics to compare against (peer/benchmark)
 * @returns {{ value, drivers: Array<{name,value,contributionPct}>, dominantDriver }|null}
 */
export const decomposeCpa = (actual, reference = null) => {
  const a = actual || {};
  if (!a.cpm || !a.ctr || !a.cvr) return null;

  // Driver list with their values.
  const drivers = [
    { name: "CPM", value: a.cpm, dir: +1 },   // higher CPM → higher CPA
    { name: "CTR", value: a.ctr, dir: -1 },   // higher CTR → lower CPA
    { name: "CVR", value: a.cvr, dir: -1 },   // higher CVR → lower CPA
  ];

  if (!reference || !reference.cpm || !reference.ctr || !reference.cvr) {
    // No reference: contribution = share of |ln(driver)| magnitude. Coarse but
    // useful to point at the dominant lever.
    const mags = drivers.map((d) => Math.abs(Math.log(d.value)));
    const total = mags.reduce((s, m) => s + m, 0) || 1;
    const withPct = drivers.map((d, i) => ({
      name: d.name,
      value: d.value,
      contributionPct: round((mags[i] / total) * 100, 1),
    }));
    return {
      value: a.cpa,
      drivers: withPct,
      dominantDriver: withPct.slice().sort((x, y) => y.contributionPct - x.contributionPct)[0]?.name,
      hasReference: false,
    };
  }

  // With reference: attribute the ln-gap of CPA to each driver.
  const refMap = { CPM: reference.cpm, CTR: reference.ctr, CVR: reference.cvr };
  const gaps = drivers.map((d) => {
    // dir applies the sign of the driver's effect on CPA.
    const lnGap = d.dir * Math.log(d.value / refMap[d.name]);
    return { name: d.name, value: d.value, lnGap };
  });
  const totalAbs = gaps.reduce((s, g) => s + Math.abs(g.lnGap), 0) || 1;
  const withPct = gaps.map((g) => ({
    name: g.name,
    value: g.value,
    contributionPct: round((Math.abs(g.lnGap) / totalAbs) * 100, 1),
  }));

  return {
    value: a.cpa,
    reference: reference.cpa,
    drivers: withPct,
    dominantDriver: withPct.slice().sort((x, y) => y.contributionPct - x.contributionPct)[0]?.name,
    hasReference: true,
  };
};

/**
 * Decompose ROAS = (AOV * CVR) / CPC into AOV, CVR, CPC drivers.
 */
export const decomposeRoas = ({ aov, cvr, cpc, roas }) => {
  if (!aov || !cvr || !cpc) return null;
  const drivers = [
    { name: "AOV", value: aov },
    { name: "CVR", value: cvr },
    { name: "CPC", value: cpc },
  ];
  const mags = drivers.map((d) => Math.abs(Math.log(d.value)));
  const total = mags.reduce((s, m) => s + m, 0) || 1;
  const withPct = drivers.map((d, i) => ({
    name: d.name,
    value: d.value,
    contributionPct: round((mags[i] / total) * 100, 1),
  }));
  return {
    value: roas ?? round((aov * cvr) / cpc, 2),
    drivers: withPct,
    dominantDriver: withPct.slice().sort((x, y) => y.contributionPct - x.contributionPct)[0]?.name,
  };
};

/**
 * Diagnose whether a high CPA is driven by expensive/low-relevance clicks
 * (CTR below benchmark) or by weak post-click conversion (CTR healthy but
 * CPA still over target). Uses only metrics already available. Facts only —
 * no prose narrative, no LLM.
 *
 * @returns null when CPA is at/under target or inputs missing.
 */
export const diagnoseCpaDriver = ({
  actualCpa,
  targetCpa,
  actualCtr,
  benchmarkCtrWarning,
  benchmarkCtrGood,
}) => {
  if (!actualCpa || !targetCpa || actualCpa <= targetCpa) return null;

  const cpaOverTargetPct = round(((actualCpa - targetCpa) / targetCpa) * 100, 1);
  const ctrHealthy =
    actualCtr != null && benchmarkCtrWarning != null
      ? actualCtr >= benchmarkCtrWarning
      : null;

  let dominantDriver;
  let explanation;
  if (ctrHealthy === true) {
    dominantDriver = "conversion_rate";
    explanation =
      "CPA is over target but CTR is at/above benchmark — the bottleneck is post-click conversion (landing page, offer, or tracking), not click cost.";
  } else if (ctrHealthy === false) {
    dominantDriver = "click_cost";
    explanation =
      "CPA is over target and CTR is below benchmark — expensive, low-relevance clicks are the primary driver. Fix creative/targeting relevance first.";
  } else {
    dominantDriver = "unknown";
    explanation =
      "CPA is over target; insufficient CTR/benchmark data to attribute the driver.";
  }

  return {
    metric: "CPA",
    actual: actualCpa,
    reference: targetCpa,
    dominantDriver,
    driverDeltas: {
      cpaOverTargetPct,
      actualCtr: actualCtr ?? null,
      benchmarkCtrWarning: benchmarkCtrWarning ?? null,
      benchmarkCtrGood: benchmarkCtrGood ?? null,
      ctrHealthy,
    },
    explanationFacts: [
      `Actual CPA $${actualCpa} vs target $${targetCpa} (${cpaOverTargetPct}% over target).`,
      actualCtr != null
        ? `Actual CTR ${actualCtr}% vs benchmark (warning ${benchmarkCtrWarning}%, good ${benchmarkCtrGood}%).`
        : "CTR not available for this account.",
      explanation,
    ],
  };
};

/**
 * Diagnose a ROAS shortfall. Only returns a confident driver when the
 * supporting inputs are present (AOV/CVR/CPC); otherwise returns a structured
 * shortfall with available facts and dominantDriver "unknown". Conservative
 * by design — we do not guess when the data is absent.
 */
export const diagnoseRoasDriver = ({ actualRoas, targetRoas, aov, cvr, cpc }) => {
  if (!actualRoas || !targetRoas || actualRoas >= targetRoas) return null;

  const shortfallPct = round(((targetRoas - actualRoas) / targetRoas) * 100, 1);
  const haveLegs = aov != null && cvr != null && cpc != null;

  let dominantDriver = "unknown";
  let explanation =
    "ROAS is below target; conversion-value and click-cost detail not available to attribute the driver.";

  if (haveLegs) {
    // ROAS = (AOV * CVR) / CPC. A low CVR or low AOV vs a high CPC tells us
    // whether the shortfall is value-side or traffic-cost-side. We compare the
    // value leg (AOV*CVR) magnitude against the cost leg (CPC).
    const valueLeg = aov * cvr;
    dominantDriver = valueLeg < cpc ? "conversion_value" : "click_cost";
    explanation =
      dominantDriver === "conversion_value"
        ? "Revenue per click (AOV × CVR) is the limiting factor — the shortfall is conversion-value driven, not traffic-cost driven."
        : "Click cost (CPC) outpaces revenue per click — the shortfall is traffic-cost driven.";
  }

  return {
    metric: "ROAS",
    actual: actualRoas,
    reference: targetRoas,
    dominantDriver,
    driverDeltas: { shortfallPct, aov: aov ?? null, cvr: cvr ?? null, cpc: cpc ?? null },
    explanationFacts: [
      `Actual ROAS ${actualRoas}× vs target ${targetRoas}× (${shortfallPct}% short).`,
      explanation,
    ],
  };
};

export const __test__ = { safeDiv, round };
