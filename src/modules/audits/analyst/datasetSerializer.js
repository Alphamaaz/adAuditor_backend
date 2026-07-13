/**
 * AI Analyst — dataset serializer. (spec: docs/AI_ANALYST_SPEC.md §3.1)
 *
 * Turns the full normalized dataset into compact, token-efficient text tables
 * the analyst model can reason over. Pipe-separated rows with one header line
 * per table — JSON keys per row waste ~3× the tokens for the same facts.
 *
 * Hard rules:
 *   - Pure over the audit bundle. No DB, no LLM, no writes.
 *   - Never throws on malformed data — skips what it can't read and records it.
 *   - Deterministic: same dataset in → same text out (stable ordering).
 *   - Size-guarded: stays under `maxTokens` via a documented truncation order;
 *     every truncation is recorded in the output so the model knows what it
 *     is NOT seeing.
 */

import { rowsWithAnalystRefs } from "./analystRowRef.js";

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** chars/4 is the standard rough token estimate for English + numbers. */
export const estimateTokens = (text) => Math.ceil(String(text || "").length / 4);

// Preferred column order — known columns first (most informative for the
// model), anything else alphabetical after. ID-ish columns are excluded
// entirely: platform-native IDs are long, high-entropy, and analytically inert.
const KNOWN_COLUMNS = [
  "rowRef",
  "name",
  "campaignName",
  "adsetName",
  "adGroupName",
  "date",
  "status",
  "objective",
  "channelType",
  "advertisingChannelType",
  "campaignType",
  "type",
  "network",
  "biddingStrategy",
  "bidStrategy",
  "dailyBudget",
  "budget",
  "targetCpa",
  "targetRoas",
  "learningPhase",
  "matchType",
  "qualityScore",
  "keyword",
  "searchTerm",
  "segment",
  "value",
  "spend",
  "impressions",
  "clicks",
  "results",
  "conversions",
  "conversionValue",
  "revenue",
  "reach",
  "frequency",
  "videoViews",
];

const EXCLUDED_KEY_RX = /(^id$|Id$|_id$|^level$|^currency$|^source$)/;

const isScalar = (v) =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

const formatCell = (v) => {
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "-";
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }
  // Pipes and newlines would corrupt the table structure.
  return String(v).replace(/[|\n\r]+/g, " ").trim() || "-";
};

/** Union of scalar keys across rows, ordered known-first. */
const tableColumns = (rows) => {
  const present = new Set();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row || {})) {
      if (EXCLUDED_KEY_RX.test(key)) continue;
      if (!isScalar(value)) continue;
      present.add(key);
    }
  }
  const known = KNOWN_COLUMNS.filter((k) => present.has(k));
  const rest = [...present].filter((k) => !KNOWN_COLUMNS.includes(k)).sort();
  return [...known, ...rest];
};

const sortRows = (rows) =>
  [...rows].sort((a, b) => {
    const spendDiff = (num(b?.spend) || 0) - (num(a?.spend) || 0);
    if (spendDiff !== 0) return spendDiff;
    const imprDiff = (num(b?.impressions) || 0) - (num(a?.impressions) || 0);
    if (imprDiff !== 0) return imprDiff;
    return String(a?.name || a?.date || "").localeCompare(String(b?.name || b?.date || ""));
  });

// Daily rows stay chronological — sorting them by spend destroys the series.
const isDailyTable = (key) => /(^|_)day|daily|^date/i.test(key);

const renderTable = ({ platform, key, rows, note }) => {
  const columns = tableColumns(rows);
  if (columns.length === 0 || rows.length === 0) return null;
  const lines = [
    `## ${platform} ${key} (${rows.length} rows${note ? `; ${note}` : ""})`,
    columns.join(" | "),
  ];
  for (const row of rows) {
    lines.push(columns.map((c) => formatCell(row?.[c])).join(" | "));
  }
  return lines.join("\n");
};

/**
 * Collect every table in the dataset as { platform, key, kind, rows }.
 * kind ∈ level | dimension | day — drives the truncation order.
 */
const collectTables = (audit) => {
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  const tables = [];
  for (const [platform, pd] of Object.entries(platforms)) {
    for (const [level, rows] of Object.entries(pd?.byLevel || {})) {
      if (Array.isArray(rows) && rows.length > 0) {
        tables.push({
          platform,
          key: level,
          kind: "level",
          rows: rowsWithAnalystRefs({ platform, table: level, rows }).map(
            ({ row, rowRef }) => ({ ...row, rowRef })
          ),
        });
      }
    }
    for (const [dim, rows] of Object.entries(pd?.byDimension || {})) {
      if (Array.isArray(rows) && rows.length > 0) {
        tables.push({
          platform,
          key: dim,
          kind: "dimension",
          rows: rowsWithAnalystRefs({ platform, table: dim, rows }).map(
            ({ row, rowRef }) => ({ ...row, rowRef })
          ),
        });
      }
    }
    if (Array.isArray(pd?.byDay) && pd.byDay.length > 0) {
      tables.push({
        platform,
        key: "byDay",
        kind: "day",
        rows: rowsWithAnalystRefs({ platform, table: "byDay", rows: pd.byDay }).map(
          ({ row, rowRef }) => ({ ...row, rowRef })
        ),
      });
    }
  }
  return tables;
};

const totalSpendOf = (rows) =>
  rows.reduce((sum, r) => sum + (num(r?.spend) || 0), 0);

/**
 * Truncation steps, applied in order until under budget. Each returns
 * { rows, note } for a table it shrank, or null when not applicable.
 * Order (spec §3.1): per-campaign daily series → sub-1%-spend ad rows →
 * zero-delivery keyword/search-term rows → generic top-N caps.
 */
const TRUNCATION_STEPS = [
  {
    name: "cap_daily_series",
    applies: (t) => (t.kind === "day" || isDailyTable(t.key)) && t.rows.length > 120,
    apply: (t) => ({
      rows: t.rows.slice(-120),
      note: `last 120 of ${t.rows.length} rows (oldest truncated)`,
    }),
  },
  {
    name: "drop_tail_ads",
    applies: (t) => t.kind === "level" && t.key === "ad" && t.rows.length > 80,
    apply: (t) => {
      const total = totalSpendOf(t.rows);
      const sorted = sortRows(t.rows);
      const kept = sorted.filter(
        (r, i) => i < 80 || (total > 0 && (num(r?.spend) || 0) / total >= 0.01)
      );
      return { rows: kept, note: `top ${kept.length} of ${t.rows.length} by spend (sub-1%-spend tail truncated)` };
    },
  },
  {
    name: "drop_zero_delivery_keywords",
    applies: (t) =>
      t.kind === "level" && /keyword|search_term/i.test(t.key) && t.rows.length > 200,
    apply: (t) => {
      const sorted = sortRows(t.rows);
      const withSpend = sorted.filter((r) => (num(r?.spend) || 0) > 0);
      const zeroSpend = sorted.filter((r) => !((num(r?.spend) || 0) > 0));
      const kept = [...withSpend, ...zeroSpend.slice(0, Math.max(0, 200 - withSpend.length))];
      return {
        rows: kept,
        note: `all ${withSpend.length} spending rows + top zero-spend by impressions (${t.rows.length} total, rest truncated)`,
      };
    },
  },
  {
    name: "generic_top_150",
    applies: (t) => t.rows.length > 150 && t.key !== "campaign",
    apply: (t) => ({
      rows: isDailyTable(t.key) ? t.rows.slice(-150) : sortRows(t.rows).slice(0, 150),
      note: `top 150 of ${t.rows.length} rows${isDailyTable(t.key) ? " (most recent)" : " by spend"}`,
    }),
  },
];

const dateRangeOf = (audit) => {
  const platforms = audit?.normalizedDataset?.data?.platforms || {};
  let min = null;
  let max = null;
  for (const pd of Object.values(platforms)) {
    for (const row of pd?.byDay || []) {
      const d = String(row?.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
  }
  return min && max ? `${min} → ${max}` : null;
};

const currencyOf = (audit) => {
  const summary = audit?.normalizedDataset?.summary || {};
  for (const p of Object.values(summary.platforms || {})) {
    if (p?.currency) return p.currency;
  }
  return summary?.totals?.currency || "USD";
};

/**
 * Serialize one full slice of a dataset table on demand — the drill-down the
 * analyst model uses when the main prompt's tables were truncated (Phase B).
 * Never throws; unknown tables return ok:false with the available table list
 * so the model can self-correct.
 *
 * @param {object} audit
 * @param {object} args
 * @param {string} args.table       table key (byLevel/byDimension key or "byDay")
 * @param {string} [args.platform]  GOOGLE | META | TIKTOK
 * @param {string} [args.match]     case-insensitive substring filter on row text
 * @param {number} [args.limit=150] max rows returned (hard cap 300)
 * @returns {{ ok: boolean, text: string, rowCount?: number }}
 */
export const serializeSlice = (audit, { table, platform, match, limit = 150 } = {}) => {
  const tables = collectTables(audit);
  const wanted = String(table || "").toLowerCase().trim();
  const found = tables.find(
    (t) =>
      (!platform || t.platform === platform) &&
      (t.key.toLowerCase() === wanted || (wanted === "byday" && t.kind === "day"))
  );
  if (!found) {
    const available = tables.map((t) => `${t.platform}:${t.key}`).join(", ");
    return { ok: false, text: `No table named "${table}". Available tables: ${available}` };
  }

  let rows = found.rows;
  if (match) {
    const needle = String(match).toLowerCase();
    rows = rows.filter((r) =>
      [r?.rowRef, r?.name, r?.campaignName, r?.adsetName, r?.adGroupName, r?.value, r?.segment, r?.keyword, r?.searchTerm]
        .some((v) => v != null && String(v).toLowerCase().includes(needle))
    );
  }
  const cap = Math.max(1, Math.min(Number(limit) || 150, 300));
  const daily = found.kind === "day" || isDailyTable(found.key);
  const total = rows.length;
  rows = daily ? rows.slice(-cap) : sortRows(rows).slice(0, cap);

  const text = renderTable({
    platform: found.platform,
    key: found.key,
    rows,
    note: `slice: ${rows.length} of ${total} matching rows${match ? ` for "${match}"` : ""}`,
  });
  return text
    ? { ok: true, text, rowCount: rows.length }
    : { ok: false, text: `Table "${table}" matched no rows${match ? ` for "${match}"` : ""}.` };
};

/**
 * Serialize the audit's raw dataset for the analyst model.
 *
 * @param {object} audit  audit with normalizedDataset (+ businessProfileSnapshot)
 * @param {object} [opts]
 * @param {number} [opts.maxTokens=150000]  input-token budget for the dataset text
 * @param {string[]} [opts.quarantinedCampaigns=[]]  anomaly-quarantined campaign names
 * @returns {{ text: string, tokenEstimate: number, truncations: Array, tableCount: number, currency: string }}
 */
export const serializeDatasetForAnalyst = (
  audit,
  { maxTokens = 150000, quarantinedCampaigns = [] } = {}
) => {
  const currency = currencyOf(audit);
  const totals = audit?.normalizedDataset?.summary?.totals || {};
  const range = dateRangeOf(audit);
  const bp = audit?.businessProfileSnapshot?.sectionA || {};

  const preamble = [
    "# RAW ACCOUNT DATA",
    `All money figures are in ${currency}. Numeric tables are pipe-separated; "-" means missing.`,
    "For facts: platform is the platform code; table is ONLY the key after it (campaign, ad, country, byDay); rows must copy the FULL rowRef exactly. Names are display labels only and may be duplicated.",
    `Platforms: ${(audit?.selectedPlatforms || []).join(", ") || "unknown"}.`,
    range ? `Date range: ${range}.` : null,
    `Account totals: spend ${formatCell(num(totals.spend))}, impressions ${formatCell(
      num(totals.impressions)
    )}, clicks ${formatCell(num(totals.clicks))}, conversions ${formatCell(num(totals.conversions))}.`,
    bp.businessType ? `Business type: ${bp.businessType}.` : null,
    quarantinedCampaigns.length > 0
      ? `TRACKING-ANOMALY QUARANTINE: the reported conversions of ${quarantinedCampaigns
          .map((n) => `"${n}"`)
          .join(", ")} are implausibly cheap and NOT trusted (likely button-tap/pixel misfires). Treat them as diagnostic only — never recommend scaling them or using their CPA as a benchmark.`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Deterministic table order: platform asc, then level < dimension < day,
  // then key asc. Campaign always leads within levels.
  const kindRank = { level: 0, dimension: 1, day: 2 };
  const keyRank = (t) => (t.key === "campaign" ? "0" : t.key === "adset" ? "1" : `9${t.key}`);
  const tables = collectTables(audit).sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      kindRank[a.kind] - kindRank[b.kind] ||
      keyRank(a).localeCompare(keyRank(b))
  );

  // Sort non-daily tables by spend so truncation (if any) drops the tail.
  for (const t of tables) {
    if (!(t.kind === "day" || isDailyTable(t.key))) t.rows = sortRows(t.rows);
  }

  const truncations = [];
  const render = () =>
    [preamble, ...tables.map((t) => renderTable(t)).filter(Boolean)].join("\n\n");

  let text = render();
  for (const step of TRUNCATION_STEPS) {
    if (estimateTokens(text) <= maxTokens) break;
    for (const t of tables) {
      if (estimateTokens(text) <= maxTokens) break;
      if (!step.applies(t)) continue;
      const before = t.rows.length;
      const { rows, note } = step.apply(t);
      if (rows.length >= before) continue;
      t.rows = rows;
      t.note = note;
      truncations.push({ step: step.name, platform: t.platform, table: t.key, before, after: rows.length });
      text = render();
    }
  }

  // Last resort: hard-cap every table except campaign to top 60. Campaigns are
  // never truncated — an audit that can't see every campaign isn't an audit.
  if (estimateTokens(text) > maxTokens) {
    for (const t of tables) {
      if (t.key === "campaign" || t.rows.length <= 60) continue;
      const before = t.rows.length;
      t.rows = isDailyTable(t.key) ? t.rows.slice(-60) : t.rows.slice(0, 60);
      t.note = `top 60 of ${before} rows (hard cap)`;
      truncations.push({ step: "hard_cap_60", platform: t.platform, table: t.key, before, after: 60 });
    }
    text = render();
  }

  return {
    text,
    tokenEstimate: estimateTokens(text),
    truncations,
    tableCount: tables.length,
    currency,
  };
};
