/**
 * AI Analyst — deterministic verification. (spec: docs/AI_ANALYST_SPEC.md §5)
 *
 * The moat over a raw LLM audit: every figure the model cites is recomputed
 * from the dataset with plain arithmetic. What verifies is kept — with the
 * figure's value REPLACED by the recomputed value, so the report always shows
 * deterministic numbers. What doesn't verify is stripped and logged, and the
 * finding's confidence is downgraded.
 *
 * Policy table:
 *   verifiable op, within tolerance   → keep, value := recomputed
 *   verifiable op, outside tolerance  → drop figure, downgrade confidence
 *   op "estimate"                     → never verified; if kind=recoverable,
 *                                       demote kind to "observation"
 *   scale-into-quarantined campaign   → deep-dive verdict forced to
 *                                       "verify-tracking"; finding flagged
 *   missing ruleId disposition        → appended as "confirmed"
 *   "refuted" without a note          → reverted to "confirmed"
 *
 * Pure over the audit bundle. No DB, no LLM, no writes. Never throws.
 */

import {
  analystRowDisplayName,
  isAnalystRowRef,
  rowsWithAnalystRefs,
} from "./analystRowRef.js";
import {
  collectAnalystEntityLabels,
  collectDatasetNumericPool,
  sanitizeNumericProse,
} from "./analystProseVerification.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The display key of a dataset row — mirrors how tables are printed. */
const metricOf = (row, metric) => {
  const m = String(metric || "").trim();
  if (m === "conversions" || m === "results") {
    return num(row?.results ?? row?.conversions);
  }
  return num(row?.[m]);
};

/** Resolve a compute.table reference against the dataset (case-insensitive). */
const resolveTable = (audit, platform, table) => {
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  let resolvedPlatform = platform || null;
  let tableKey = String(table || "").trim();
  for (const candidatePlatform of Object.keys(platforms)) {
    const prefix = new RegExp(`^${candidatePlatform}(?:\\s+|:)`, "i");
    if (prefix.test(tableKey)) {
      resolvedPlatform ||= candidatePlatform;
      tableKey = tableKey.replace(prefix, "").trim();
      break;
    }
  }
  const candidates = resolvedPlatform
    ? { [resolvedPlatform]: platforms[resolvedPlatform] }
    : platforms;
  const wanted = norm(tableKey);
  const matches = [];
  for (const [candidatePlatform, pd] of Object.entries(candidates)) {
    if (!pd) continue;
    if (wanted === "byday" || wanted === "day" || wanted === "daily") {
      if (Array.isArray(pd.byDay) && pd.byDay.length > 0) {
        matches.push({ platform: candidatePlatform, table: "byDay", rows: pd.byDay });
      }
      continue;
    }
    for (const [key, rows] of Object.entries(pd.byLevel || {})) {
      if (norm(key) === wanted && Array.isArray(rows)) {
        matches.push({ platform: candidatePlatform, table: key, rows });
      }
    }
    for (const [key, rows] of Object.entries(pd.byDimension || {})) {
      if (norm(key) === wanted && Array.isArray(rows)) {
        matches.push({ platform: candidatePlatform, table: key, rows });
      }
    }
  }
  if (matches.length === 1) return { ok: true, ...matches[0] };
  if (matches.length > 1) return { ok: false, reason: `ambiguous_table:${table}` };
  return { ok: false, reason: `table_not_found:${table}` };
};

const resolveRows = ({ tableRows, refs, platform, table }) => {
  if (!Array.isArray(tableRows)) return { ok: false, reason: "rows_not_resolved" };
  const list = Array.isArray(refs) ? refs : [];
  if (list.length === 0) return { ok: false, reason: "rows_not_resolved" };
  if (list.length === 1 && norm(list[0]) === "all") {
    return { ok: true, rows: tableRows };
  }
  const indexed = rowsWithAnalystRefs({ platform, table, rows: tableRows });
  const resolved = [];
  const seen = new Set();
  for (const ref of list) {
    const shortRowRef = /^r_[a-f0-9]{12}$/i.test(String(ref || ""));
    const matches = isAnalystRowRef(ref)
      ? indexed.filter((entry) => norm(entry.rowRef) === norm(ref))
      : shortRowRef
        ? indexed.filter(
            (entry) => norm(entry.rowRef).split(":").at(-1) === norm(ref)
          )
        : indexed.filter(
            (entry) => norm(analystRowDisplayName(entry.row)) === norm(ref)
          );
    if (matches.length !== 1) {
      return {
        ok: false,
        reason: matches.length > 1 ? `ambiguous_row:${ref}` : "rows_not_resolved",
      };
    }
    if (!seen.has(matches[0].rowRef)) {
      seen.add(matches[0].rowRef);
      resolved.push(matches[0].row);
    }
  }
  // Every referenced row must resolve — a partial match silently computes
  // over the wrong population.
  return { ok: true, rows: resolved };
};

/**
 * Recompute one figure. Returns { ok: true, value } | { ok: false, reason }.
 * "estimate" is structurally unverifiable → { ok: false, reason: "estimate" }.
 */
export const recomputeFigure = (audit, compute) => {
  const op = compute?.op;
  if (!op) return { ok: false, reason: "missing_op" };
  if (op === "estimate") return { ok: false, reason: "estimate" };

  const tableResult = resolveTable(audit, compute.platform || null, compute.table);
  if (!tableResult.ok) return tableResult;
  const rowResult = resolveRows({
    tableRows: tableResult.rows,
    refs: compute.rows,
    platform: tableResult.platform,
    table: tableResult.table,
  });
  if (!rowResult.ok) return rowResult;
  const rows = rowResult.rows;

  if (op === "raw") {
    if (rows.length !== 1) return { ok: false, reason: "raw_needs_one_row" };
    if (!compute.metric) return { ok: false, reason: "missing_metric" };
    return { ok: true, value: metricOf(rows[0], compute.metric) };
  }

  if (op === "sum") {
    if (!compute.metric) return { ok: false, reason: "missing_metric" };
    return { ok: true, value: rows.reduce((s, r) => s + metricOf(r, compute.metric), 0) };
  }

  if (op === "ratio") {
    if (!compute.numerator || !compute.denominator) {
      return { ok: false, reason: "missing_ratio_fields" };
    }
    const numSum = rows.reduce((s, r) => s + metricOf(r, compute.numerator), 0);
    const denSum = rows.reduce((s, r) => s + metricOf(r, compute.denominator), 0);
    if (denSum === 0) return { ok: false, reason: "zero_denominator" };
    return { ok: true, value: (numSum / denSum) * (num(compute.scale) || 1) };
  }

  if (op === "share") {
    if (!compute.metric) return { ok: false, reason: "missing_metric" };
    const part = rows.reduce((s, r) => s + metricOf(r, compute.metric), 0);
    const whole = tableResult.rows.reduce((s, r) => s + metricOf(r, compute.metric), 0);
    if (whole === 0) return { ok: false, reason: "zero_total" };
    return { ok: true, value: (part / whole) * 100 };
  }

  if (op === "excess_spend") {
    const refCpa = num(compute.referenceCpa);
    if (!(refCpa > 0)) return { ok: false, reason: "missing_reference_cpa" };
    const spend = rows.reduce((s, r) => s + metricOf(r, "spend"), 0);
    const conversions = rows.reduce((s, r) => s + metricOf(r, "conversions"), 0);
    return { ok: true, value: spend - conversions * refCpa };
  }

  return { ok: false, reason: `unknown_op:${op}` };
};

/** 1.5% relative or 1 absolute — covers rounding in both directions. */
const withinTolerance = (claimed, recomputed) => {
  const diff = Math.abs(num(claimed) - num(recomputed));
  return diff <= Math.max(Math.abs(num(recomputed)) * 0.015, 1);
};

const CONFIDENCE_DOWN = { high: "medium", medium: "low", low: "low" };

const SCALE_LANGUAGE_RX = /\b(scale|scaling|increase (the )?budget|more budget|raise (the )?budget|duplicate and expand)\b/i;

/**
 * Verify a full analyst report against the dataset.
 *
 * @param {object} args
 * @param {object} args.report                parsed analyst output
 * @param {object} args.audit                 audit with normalizedDataset + ruleFindings
 * @param {string[]} [args.quarantinedCampaigns]
 * @returns {{ report, stats, droppedFigures }}
 */
export const verifyAnalystReport = ({ report, audit, quarantinedCampaigns = [] }) => {
  const quarantine = new Set(quarantinedCampaigns.map(norm));
  const entityLabels = collectAnalystEntityLabels(audit);
  const droppedFigures = [];
  const droppedClaims = [];
  const stats = {
    figuresTotal: 0,
    figuresVerified: 0,
    figuresDropped: 0,
    estimatesDemoted: 0,
    findingsDowngraded: 0,
    deepDivesQuarantineFixed: 0,
    dispositionsAppended: 0,
    refutationsReverted: 0,
    proseFieldsChecked: 0,
    proseSentencesDropped: 0,
    unsupportedNumericClaims: 0,
    prescriptiveUnsupportedClaims: 0,
  };

  const verifyFigureList = (figures, ownerPath) => {
    const kept = [];
    let anyDropped = false;
    for (const [index, figure] of (figures || []).entries()) {
      stats.figuresTotal += 1;
      const result = recomputeFigure(audit, figure?.compute);

      if (result.ok) {
        if (withinTolerance(figure.value, result.value)) {
          stats.figuresVerified += 1;
          kept.push({
            ...figure,
            value: Math.round(result.value * 100) / 100, // deterministic value wins
            verified: true,
          });
        } else {
          stats.figuresDropped += 1;
          anyDropped = true;
          droppedFigures.push({
            path: `${ownerPath}.figures[${index}]`,
            label: figure?.label,
            kind: figure?.kind || null,
            compute: figure?.compute || null,
            claimed: figure?.value,
            recomputed: Math.round(result.value * 100) / 100,
            reason: "out_of_tolerance",
          });
        }
        continue;
      }

      if (result.reason === "estimate") {
        if (figure?.kind === "recoverable") {
          // A projection can never be presented as recoverable money.
          stats.estimatesDemoted += 1;
          kept.push({ ...figure, kind: "observation", verified: false });
        } else {
          kept.push({ ...figure, verified: false });
        }
        continue;
      }

      stats.figuresDropped += 1;
      anyDropped = true;
      droppedFigures.push({
        path: `${ownerPath}.figures[${index}]`,
        label: figure?.label,
        kind: figure?.kind || null,
        compute: figure?.compute || null,
        claimed: figure?.value,
        recomputed: null,
        reason: result.reason,
      });
    }
    return { kept, anyDropped };
  };

  // ── Figures first, prose second ───────────────────────────────────────────
  // All figure lists are verified BEFORE any prose check so prose can be
  // measured against the report-wide pool of verified values plus the numbers
  // the dataset itself vouches for (cell values, derived ratios, totals, row
  // counts). Same-object-only matching amputated TRUE sentences on the first
  // live eval — a correct number is a correct number wherever it was attached.
  const executive = verifyFigureList(report.executiveFigures, "executiveFigures");
  const rootCause = verifyFigureList(report.rootCauseFigures, "rootCauseFigures");
  // Repair-turn facts (analystRun) land here so their verified values can
  // rescue prose sentences anywhere in the report.
  const supplemental = verifyFigureList(report.supplementalFigures, "supplementalFigures");
  const findingsKept = (report.findings || []).map((finding, i) =>
    verifyFigureList(finding.figures, `findings[${i}]`)
  );
  const divesKept = (report.campaignDeepDives || []).map((dive, i) =>
    verifyFigureList(dive.figures, `campaignDeepDives[${i}]`)
  );
  const recsKept = (report.recommendations || []).map((rec, i) =>
    verifyFigureList(rec.figures, `recommendations[${i}]`)
  );
  const dispsKept = (report.ruleFindingDispositions || []).map((disposition, i) =>
    verifyFigureList(disposition.figures, `ruleFindingDispositions[${i}]`)
  );

  const datasetPool = collectDatasetNumericPool(audit);
  const reportPool = [
    ...executive.kept,
    ...rootCause.kept,
    ...supplemental.kept,
    ...findingsKept.flatMap((r) => r.kept),
    ...divesKept.flatMap((r) => r.kept),
    ...recsKept.flatMap((r) => r.kept),
    ...dispsKept.flatMap((r) => r.kept),
  ]
    .filter((figure) => figure?.verified === true && Number.isFinite(Number(figure.value)))
    .map((figure) => Number(figure.value));

  const verifyProse = (text, figures, path, fallback = "", { prescriptive = false } = {}) => {
    stats.proseFieldsChecked += 1;
    const result = sanitizeNumericProse({
      text,
      figures,
      reportPool,
      datasetPool,
      entityLabels,
      prescriptive,
      path,
    });
    if (result.dropped.length > 0) {
      droppedClaims.push(...result.dropped);
      stats.proseSentencesDropped += result.dropped.length;
      stats.unsupportedNumericClaims += result.dropped.reduce(
        (sum, item) => sum + item.unsupported.length,
        0
      );
    }
    stats.prescriptiveUnsupportedClaims += result.prescriptiveUnsupported.reduce(
      (sum, item) => sum + item.unsupported.length,
      0
    );
    return result.text || fallback;
  };

  const executiveSummary = verifyProse(
    report.executiveSummary,
    executive.kept,
    "executiveSummary",
    "The verified account data supports the findings below; unsupported numerical claims were removed."
  );
  const verifiedRootCause = verifyProse(
    report.rootCause,
    rootCause.kept,
    "rootCause",
    "The verified evidence does not support a single numerical root-cause statement."
  );

  const findings = (report.findings || []).map((finding, i) => {
    const { kept, anyDropped } = findingsKept[i];
    const title = verifyProse(
      finding.title,
      kept,
      `findings[${i}].title`,
      `Verified ${finding.category || "account"} issue`
    );
    const claim = verifyProse(
      finding.claim,
      kept,
      `findings[${i}].claim`,
      "The unsupported numerical portion of this finding was removed."
    );
    let confidence = finding.confidence;
    if (anyDropped) {
      confidence = CONFIDENCE_DOWN[confidence] || "low";
      stats.findingsDowngraded += 1;
    }

    // A finding that pushes spend INTO a quarantined campaign is inverted:
    // the real action is verifying its tracking.
    const touchesQuarantine = (finding.campaignRefs || []).some((ref) =>
      quarantine.has(norm(ref))
    );
    const requestedQuarantinedScale =
      touchesQuarantine &&
      SCALE_LANGUAGE_RX.test(String(finding.recommendation || ""));
    let recommendation = verifyProse(
      finding.recommendation,
      kept,
      `findings[${i}].recommendation`,
      "Review the verified evidence before changing account settings.",
      { prescriptive: true }
    );
    let quarantineFlag = false;
    if (requestedQuarantinedScale) {
      quarantineFlag = true;
      recommendation = `Verify this campaign's conversion tracking before any budget change — its reported conversions are quarantined as implausible. (Original suggestion withheld: ${recommendation})`;
    }

    const netRecoverable = kept
      .filter((f) => f.kind === "recoverable" && f.verified)
      .reduce((s, f) => s + Math.max(0, num(f.value)), 0);

    return {
      ...finding,
      title,
      claim,
      figures: kept,
      confidence,
      recommendation,
      quarantineFlag,
      verifiedRecoverable: Math.round(netRecoverable * 100) / 100,
    };
  });

  // ── Deep dives ────────────────────────────────────────────────────────────
  const campaignDeepDives = (report.campaignDeepDives || []).map((dive, i) => {
    const { kept } = divesKept[i];
    const diagnosis = verifyProse(
      dive.diagnosis,
      kept,
      `campaignDeepDives[${i}].diagnosis`,
      "The numerical diagnosis was removed because it was not fully verified."
    );
    const actions = (dive.actions || [])
      .map((action, actionIndex) =>
        verifyProse(
          action,
          kept,
          `campaignDeepDives[${i}].actions[${actionIndex}]`,
          "",
          { prescriptive: true }
        )
      )
      .filter(Boolean);
    if (dive?.verdict === "scale" && quarantine.has(norm(dive.campaignName))) {
      stats.deepDivesQuarantineFixed += 1;
      return {
        ...dive,
        figures: kept,
        actions,
        verdict: "verify-tracking",
        diagnosis: `${diagnosis} NOTE: this campaign's reported conversions are quarantined as implausibly cheap — verify tracking before treating it as a winner.`,
      };
    }
    return { ...dive, figures: kept, diagnosis, actions };
  });

  // ── Recommendations ───────────────────────────────────────────────────────
  const recommendations = (report.recommendations || []).map((rec, i) => {
    const { kept } = recsKept[i];
    return {
      ...rec,
      figures: kept,
      // The action PROPOSES values (a cap, a daily budget) — proposals are not
      // recomputable from data; expectedImpact CLAIMS an outcome and stays strict.
      action: verifyProse(
        rec.action,
        kept,
        `recommendations[${i}].action`,
        "Review the verified findings before changing account settings.",
        { prescriptive: true }
      ),
      expectedImpact: verifyProse(
        rec.expectedImpact,
        kept,
        `recommendations[${i}].expectedImpact`,
        "Expected impact was not quantified from verified evidence."
      ),
    };
  });

  // ── Rule-finding dispositions ─────────────────────────────────────────────
  const verifiedDispositions = (report.ruleFindingDispositions || []).map(
    (disposition, i) => {
      const { kept } = dispsKept[i];
      return {
        ...disposition,
        figures: kept,
        note: verifyProse(
          disposition.note,
          kept,
          `ruleFindingDispositions[${i}].note`
        ),
      };
    }
  );
  const byRuleId = new Map(verifiedDispositions.map((d) => [d.ruleId, d]));
  const dispositions = [];
  const seen = new Set();
  for (const rule of audit.ruleFindings || []) {
    if (seen.has(rule.ruleId)) continue;
    seen.add(rule.ruleId);
    const given = byRuleId.get(rule.ruleId);
    if (!given) {
      stats.dispositionsAppended += 1;
      dispositions.push({
        ruleId: rule.ruleId,
        disposition: "confirmed",
        note: null,
        figures: [],
      });
      continue;
    }
    if (given.disposition === "refuted" && !String(given.note || "").trim()) {
      stats.refutationsReverted += 1;
      dispositions.push({ ...given, disposition: "confirmed", note: null });
      continue;
    }
    dispositions.push(given);
  }

  return {
    report: {
      ...report,
      executiveSummary,
      executiveFigures: executive.kept,
      rootCause: verifiedRootCause,
      rootCauseFigures: rootCause.kept,
      ...(supplemental.kept.length > 0 ? { supplementalFigures: supplemental.kept } : {}),
      findings,
      campaignDeepDives,
      recommendations,
      ruleFindingDispositions: dispositions,
    },
    stats,
    droppedFigures,
    droppedClaims,
  };
};
