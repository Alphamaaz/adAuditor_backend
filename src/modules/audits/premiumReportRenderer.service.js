import { buildReportDocumentFromAudit } from "./reportDocument.service.js";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const markdown = (value) =>
  emphasizeNumbers(escapeHtml(cleanClientText(value)))
    .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");

const toneFill = (tone) => (tone === "warn" ? "#D29A4A" : "#1B5742");
const severityClass = (severity) => `sev-${String(severity || "LOW").toLowerCase()}`;

const hiddenFields = new Set([
  "id",
  "rule_id",
  "ruleId",
  "module",
  "version",
  "currency",
  "dimension",
]);

const labelMap = {
  segment: "Segment",
  reason: "Why flagged",
  confidence: "Confidence",
  ease: "Ease of implementation",
  easeOfImplementation: "Ease of implementation",
  sample_size: "Sample size",
  sampleSize: "Sample size",
  estimatedImpact: "Estimated impact",
  estimatedWaste: "Recoverable spend",
  wastedSpend: "Wasted spend",
  segmentCpa: "Segment CPA",
  baselineCpa: "Baseline CPA",
  currentCpa: "Current CPA",
  previousCpa: "Previous CPA",
  currentCtr: "Current CTR",
  peerCtr: "Peer CTR",
};

const toWords = (value) =>
  String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();

const sentenceCase = (value) => {
  const text = toWords(value);
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
};

const humanLabel = (value) => labelMap[value] || sentenceCase(value);

const cleanClientText = (value) =>
  String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b[A-Z]{2,}(?:-[A-Z0-9]+)+-\d{2,}\b/g, "")
    // Strip internal rule codes ("Bench CPM 001", "Str 002") from client text.
    // NOT case-insensitive: under /i the [A-Z] word class also matched lowercase
    // connectives, so a real sentence like "Meta CTR is 62.8% below…" parsed as a
    // rule code ("Meta"+"CTR"+"is"+"62") and lost its prefix → ".8% below…". The
    // middle abbreviations in a real code are uppercase (CPM/CTR/STR), so we match
    // them case-sensitively and just list both case forms of the leading keyword.
    .replace(
      /\b(?:STR|KW|OPP|AUD|CRE|DATA|BP|BENCH|SEG|DIAG|MEMORY|PEER|META|GOOGLE|TIKTOK|Str|Kw|Opp|Aud|Cre|Data|Bp|Bench|Seg|Diag|Memory|Peer|Meta|Google|Tiktok)(?:\s+[A-Z]{2,6}){0,3}\s+\d{2,}\b/g,
      ""
    )
    .replace(/\bdayOfWeek\b/g, "day of week")
    .replace(/\b([A-Z]{3,})(?:_([A-Z]{2,}))*\b/g, (match) => sentenceCase(match))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(Pkr|Usd|Eur|Gbp|Aed|Inr|Cad|Aud|Nzd|Sgd|Sar|Try|Jpy|Zar)\b/g, (m) => m.toUpperCase())
    .replace(/\b(Cpa|Cpc|Cpm|Ctr|Roas)\b/g, (m) => m.toUpperCase())
    .replace(/^([a-z])/, (m) => m.toUpperCase());

const isHiddenField = (field) => {
  const key = String(field || "");
  return hiddenFields.has(key) || key.startsWith("_") || key.startsWith("internal_") || key.startsWith("raw_");
};

const moneyLikeLabel = (label) =>
  /(spend|revenue|budget|cpa|cpc|cost|impact|recoverable|waste|value|amount)/i.test(String(label || ""));

const formatCellValue = (value, label = "", currency = "USD") => {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (/%|pct|percent|rate/i.test(label)) {
      return `${Number(value.toFixed(1)).toLocaleString("en-US")}%`;
    }
    const formatted = Math.round(value).toLocaleString("en-US");
    return moneyLikeLabel(label) ? `${currency} ${formatted}` : formatted;
  }
  const text = cleanClientText(value);
  if (/not quantified|impact not quantifiable|not safely quantifiable/i.test(text)) {
    return moneyLikeLabel(label) ? "Business risk" : "Needs review";
  }
  const money = text.match(/(\$|[A-Z]{3})\s?([\d,]+(?:\.\d+)?)(.*)$/i);
  if (money && moneyLikeLabel(label)) {
    // Preserve a 3-letter currency code already present in the string — it was
    // formatted upstream with the account's real currency (e.g. "PKR 11,021").
    // Only the bare "$" form falls back to the passed currency / default. This
    // stops a chart from re-labelling "PKR 185" as "USD 185".
    const hasCode = /^[A-Za-z]{3}$/.test(money[1]);
    const cur = hasCode ? money[1].toUpperCase() : String(currency || "USD").toUpperCase();
    return `${cur} ${money[2]}${money[3] || ""}`.trim();
  }
  const numeric = text.match(/^([\d,]+(?:\.\d+)?)$/);
  if (numeric) {
    const n = Number(numeric[1].replace(/,/g, ""));
    if (Number.isFinite(n)) return formatCellValue(n, label, currency);
  }
  if (/%|pct|percent|rate/i.test(label)) {
    const n = Number(text.replace(/%/g, ""));
    if (Number.isFinite(n)) return `${Number(n.toFixed(1)).toLocaleString("en-US")}%`;
  }
  return text;
};

const isProseCell = (value) => {
  const text = String(value || "").trim();
  if (!text) return true;
  if (text.length > 24) return true;
  if (/\.\s+\S/.test(text)) return true;
  if (text.split(/\s+/).filter(Boolean).length > 6) return true;
  return false;
};

const emphasizeNumbers = (html) =>
  html.replace(/((?:[A-Z]{3}|\$)\s?[\d,]+(?:\.\d+)?|[\d,]+(?:\.\d+)?%)/g, '<span class="num">$1</span>');

const bandColor = (band) => {
  if (["Excellent", "Good"].includes(band)) return "#6FBF94";
  if (band === "Fair") return "#D29A4A";
  return "#E07A72";
};

const formatPeriod = (period = {}) => {
  const fmt = (value) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(d);
  };
  const start = fmt(period.start);
  const end = fmt(period.end);
  if (start && end) return `${start} - ${end}`;
  return end || "Latest completed period";
};

const renderGauge = (score, band) => {
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  const dash = 195;
  const offset = dash - (dash * clamped) / 100;
  return `<svg width="150" height="96" viewBox="0 0 150 96" role="img" aria-label="Health score ${clamped} out of 100">
    <path d="M 13 88 A 62 62 0 0 1 137 88" fill="none" stroke="rgba(255,255,255,.16)" stroke-width="10" stroke-linecap="round"/>
    <path d="M 13 88 A 62 62 0 0 1 137 88" fill="none" stroke="${bandColor(band)}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${dash}" stroke-dashoffset="${offset.toFixed(1)}"/>
    <text class="g-num" x="75" y="74" text-anchor="middle">${clamped}</text>
    <text class="g-of" x="75" y="90" text-anchor="middle">HEALTH / 100</text>
  </svg>`;
};

const renderScoreGauge = (score, band = "Good", caption = "Component-level breakdown not available for this audit.") =>
  `<div class="score-gauge-card">
    <div class="score-gauge">${renderGauge(score, band)}<span class="g-band">${escapeHtml(cleanClientText(band))}</span></div>
    <p class="small">${escapeHtml(caption || "Component-level breakdown not available for this audit.")}</p>
  </div>`;

const renderMasthead = (doc, branding = {}) => {
  const m = doc.masthead;
  const bgColor = branding.primaryColor || "#0F3A2C";
  const auditedBy = branding.preparedBy || "AdAdviser Engine + AI Strategist";

  const logoHtml = branding.logoBase64
    ? `<img src="${escapeHtml(branding.logoBase64)}" alt="${escapeHtml(branding.companyName || "Logo")}" class="brand-logo"/>`
    : branding.companyName
      ? `<div class="logo">${escapeHtml(branding.companyName)}</div>`
      : `<div class="logo">Ad<b>Adviser</b></div>`;

  return `<header class="masthead" style="background:${escapeHtml(bgColor)}">
    <div class="mast-brand">
      ${logoHtml}
      <div class="doc-type">Performance Audit · ${escapeHtml(cleanClientText(m.platform))}</div>
    </div>
    <div class="mast-grid">
      <div class="mast-title">
        <h1>${escapeHtml(cleanClientText(m.headline))}</h1>
        <p class="mast-sub">${markdown(m.subline)}</p>
      </div>
      <div class="gauge">
        ${renderGauge(m.health_score, m.score_band)}
        <span class="g-band">${escapeHtml(m.score_band)}</span>
      </div>
    </div>
    <div class="mast-meta">
      <span>Prepared for<b>Client Account</b></span>
      <span>Period<b>${escapeHtml(formatPeriod(m.period))}</b></span>
      <span>Audited by<b>${escapeHtml(auditedBy)}</b></span>
      <span>Data<b>${m.tracking_verified ? "Tracking verified" : "Tracking caveat"}</b></span>
    </div>
  </header>`;
};

const renderKeyNumbers = (items = []) =>
  items.length
    ? `<div class="keystrip">${items
        .slice(0, 4)
        .map(
          (item) =>
            `<div class="kcell"><b class="${escapeHtml(item.tone || "neutral")}">${escapeHtml(cleanClientText(item.value))}</b><span>${escapeHtml(cleanClientText(item.label))}</span></div>`
        )
        .join("")}</div>`
    : "";

const renderProjection = (projection) => {
  if (!projection) return "";
  const money = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Number(value) || 0);
  return `<div class="projection">
    <div class="proj-cell"><small>This period</small><b>${money(projection.period_value)}</b><span>identified opportunity</span></div>
    <div class="proj-cell"><small>Per quarter</small><b>≈ ${money(projection.quarterly)}</b><span>if the pattern persists</span></div>
    <div class="proj-cell"><small>Annualized</small><b>≈ ${money(projection.annualized)}</b><span>directional projection</span></div>
  </div><p class="small">${escapeHtml(projection.disclaimer)}</p>`;
};

const renderExecutiveSummary = (summary = {}) => `
  <section class="section" id="executive-summary">
    <div class="eyebrow">Executive summary</div>
    <h2>What this audit found</h2>
    <div class="verdict"><p>${markdown(summary.verdict)}</p></div>
    ${(summary.paragraphs || []).map((p) => `<p>${markdown(p)}</p>`).join("")}
    ${renderProjection(summary.projection)}
  </section>`;

const renderHorizontalBars = (block) => {
  const rows = block.rows || [];
  if (!rows.length) return "";
  if (rows.length < 3 && block.kind === "score") return renderScoreGauge(block.score, block.score_band, block.caption);
  if (rows.length < 3 && !block.allowFewRows) return renderEvidenceTable({ rows: rows.map((row) => ({ metric: row.label, value: row.display ?? row.value })) });
  const labelW = 220;
  const barW = 420;
  const rowH = 34;
  const h = rows.length * rowH + 34;
  return `<div class="chart"><svg viewBox="0 0 720 ${h}" role="img" aria-label="${escapeHtml(block.caption || "Horizontal bar chart")}">
    ${block.gridlines ? [25, 50, 75, 100].map((v) => `<line class="grid" x1="${labelW + (v / 100) * barW}" y1="0" x2="${labelW + (v / 100) * barW}" y2="${rows.length * rowH}"/>`).join("") : ""}
    ${rows
      .map((row, i) => {
        const y = 10 + i * rowH;
        const max = Number(row.max) || 100;
        const width = Math.max(2, Math.min(barW, (Number(row.value) / max) * barW));
        const label = escapeHtml(cleanClientText(row.label));
        // Score rows are 0-100 points, never money/percent. Render them verbatim
        // so a category label like "Bidding & Budget" can't be mis-detected as
        // money and printed as "USD 100".
        const display = escapeHtml(
          block.kind === "score"
            ? String(row.display ?? row.value)
            : formatCellValue(row.display ?? row.value, row.label, block.currency)
        );
        return `<text class="bl" x="${labelW - 12}" y="${y + 13}" text-anchor="end">${label}</text>
          <rect x="${labelW}" y="${y}" width="${width.toFixed(1)}" height="16" rx="2.5" fill="${toneFill(row.tone)}"/>
          <text class="${width > 42 ? "bvw" : "bv"}" x="${width > 42 ? labelW + width - 10 : labelW + width + 8}" y="${y + 13}" text-anchor="${width > 42 ? "end" : "start"}">${display}</text>`;
      })
      .join("")}
    <line class="ax" x1="${labelW}" y1="0" x2="${labelW}" y2="${rows.length * rowH}"/>
  </svg>${block.caption ? `<p class="chart-cap">${escapeHtml(block.caption)}</p>` : ""}</div>`;
};

const renderVerticalBars = (block) => {
  const rows = (block.rows || []).slice(0, 12);
  if (!rows.length) return "";
  if (rows.length < 3) return renderEvidenceTable({ rows: rows.map((row) => ({ metric: row.label, value: row.display ?? row.value })) });
  const max = Math.max(...rows.map((r) => Number(r.max || r.value) || 0), Number(block.baseline?.value || 0), 1);
  const chartW = 680;
  const chartH = 220;
  const slot = chartW / rows.length;
  return `<div class="chart"><svg viewBox="0 0 720 300" role="img" aria-label="${escapeHtml(block.caption || "Vertical bar chart")}">
    ${[0.25, 0.5, 0.75, 1].map((p) => `<line class="grid" x1="28" y1="${20 + chartH * (1 - p)}" x2="710" y2="${20 + chartH * (1 - p)}"/>`).join("")}
    ${block.baseline ? `<line x1="28" y1="${20 + chartH * (1 - Number(block.baseline.value) / max)}" x2="710" y2="${20 + chartH * (1 - Number(block.baseline.value) / max)}" stroke="#9AA29C" stroke-width="1" stroke-dasharray="4 4"/><text class="bv" x="36" y="${14 + chartH * (1 - Number(block.baseline.value) / max)}">${escapeHtml(block.baseline.label)}</text>` : ""}
    ${rows
      .map((row, i) => {
        const value = Number(row.value) || 0;
        const h = Math.max(2, (value / max) * chartH);
        const x = 38 + i * slot;
        const y = 20 + chartH - h;
        return `<rect x="${x}" y="${y}" width="${Math.max(12, slot - 14)}" height="${h}" rx="2.5" fill="${toneFill(row.tone)}"/>
          <text class="bv" x="${x + Math.max(12, slot - 14) / 2}" y="${y - 6}" text-anchor="middle">${escapeHtml(formatCellValue(row.display ?? row.value, row.label, block.currency))}</text>
          <text class="bl" x="${x + Math.max(12, slot - 14) / 2}" y="274" text-anchor="middle">${escapeHtml(cleanClientText(row.label)).slice(0, 12)}</text>`;
      })
      .join("")}
    <line class="ax" x1="28" y1="20" x2="28" y2="240"/><line class="ax" x1="28" y1="240" x2="710" y2="240"/>
  </svg>${block.caption ? `<p class="chart-cap">${escapeHtml(block.caption)}</p>` : ""}</div>`;
};

const pointsToPath = (points, w, h) => {
  if (!points.length) return "";
  const ys = points.map((p) => Number(p.y) || 0);
  const minY = Math.min(...ys, 0);
  const maxY = Math.max(...ys, 1);
  const range = maxY - minY || 1;
  return points
    .map((p, i) => {
      const x = 40 + (i / Math.max(points.length - 1, 1)) * w;
      const y = 20 + h - ((Number(p.y) - minY) / range) * h;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
};

const renderLineChart = (block) => {
  const series = block.series || [];
  if (!series.length) return "";
  return `<div class="chart"><svg viewBox="0 0 720 280" role="img" aria-label="${escapeHtml(block.y_label || "Line chart")}">
    ${[40, 90, 140, 190, 240].map((y) => `<line class="grid" x1="40" y1="${y}" x2="700" y2="${y}"/>`).join("")}
    ${series
      .map((s) => `<path d="${pointsToPath(s.points || [], 640, 210)}" fill="none" stroke="${toneFill(s.tone)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("")}
    ${(block.annotations || []).map((a, i) => `<text class="bv" x="${80 + i * 160}" y="24">${escapeHtml(a.text)}</text>`).join("")}
    <line class="ax" x1="40" y1="20" x2="40" y2="240"/><line class="ax" x1="40" y1="240" x2="700" y2="240"/>
  </svg></div>`;
};

const renderEvidenceTable = (block) => {
  const currency = block.currency || "USD";
  const prose = String(block.proseContext || "");
  const rows = (block.rows || [])
    .filter((row) => !isHiddenField(row.metric))
    .map((row) => {
      const metric = humanLabel(row.metric);
      const value = formatCellValue(row.value, row.metric, currency);
      return { ...row, metric, value };
    })
    .filter((row) => row.metric && row.value && !isProseCell(row.value))
    .filter((row) => !prose || !prose.includes(String(row.value)))
    .slice(0, 8);
  if (!rows.length) return "";
  return `<table class="evidence-table"><thead><tr><th>Evidence</th><th class="num">Value</th></tr></thead><tbody>${rows
    .map((row) => `<tr><td>${escapeHtml(row.metric)}</td><td class="num ${row.highlight ? "highlight" : ""}">${escapeHtml(row.value)}</td></tr>`)
    .join("")}</tbody></table>`;
};

// Status verdict pill — the "proof" marker that makes the report read like a
// strategist's scorecard (on target / watch / off target), not a flat table.
const STATUS_LABEL = { good: "On target", warn: "Watch", bad: "Off target", neutral: "—" };
const renderStatusPill = (status, label) => {
  const s = ["good", "warn", "bad"].includes(status) ? status : "neutral";
  const text = label || STATUS_LABEL[s];
  if (s === "neutral") return `<span class="status-neutral">${escapeHtml(cleanClientText(text))}</span>`;
  return `<span class="status-pill status-${s}">${escapeHtml(cleanClientText(text))}</span>`;
};

const renderDataTable = (block) => {
  const columns = block.columns || [];
  return `<table><thead><tr>${columns
    .map((col) => `<th class="${col.align === "right" ? "num" : ""}" style="${col.width ? `width:${escapeHtml(col.width)}` : ""}">${escapeHtml(humanLabel(col.header))}</th>`)
    .join("")}</tr></thead><tbody>${(block.rows || [])
    .map((row) => `<tr>${row.map((cell, i) => {
      // A cell may be a status object { status, text } → render as a verdict pill.
      if (cell && typeof cell === "object" && cell.status) {
        return `<td>${renderStatusPill(cell.status, cell.text)}</td>`;
      }
      const value = formatCellValue(cell, columns?.[i]?.header, block.currency);
      return `<td class="${columns?.[i]?.align === "right" ? "num" : ""}">${escapeHtml(value)}</td>`;
    }).join("")}</tr>`)
    .join("")}</tbody></table>${block.footnote ? `<p class="tnote">${escapeHtml(cleanClientText(block.footnote))}</p>` : ""}`;
};

// Account scorecard — Metric | Value | Target | Status. The single most
// "Claude-like" element: every headline metric is anchored to a benchmark/target
// and given a pass/watch/fail verdict, so each claim shows its proof.
const renderScorecard = (block) => {
  const rows = block.rows || [];
  if (!rows.length) return "";
  return `<table class="scorecard"><thead><tr><th>Metric</th><th class="num">Value</th><th class="num">Target / benchmark</th><th>Status</th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(cleanClientText(r.metric))}</td><td class="num">${escapeHtml(String(r.value ?? ""))}</td><td class="num">${escapeHtml(String(r.target ?? "—"))}</td><td>${renderStatusPill(r.status, r.statusLabel)}</td></tr>`
    )
    .join("")}</tbody></table>${block.caption ? `<p class="chart-cap">${escapeHtml(block.caption)}</p>` : ""}`;
};

const renderCompositionBar = (block) => {
  let x = 0;
  return `<div class="chart"><svg viewBox="0 0 720 86" role="img" aria-label="${escapeHtml(block.caption || "Composition bar")}">
    ${(block.segments || [])
      .map((seg) => {
        const w = Math.max(0, Math.min(100, Number(seg.pct) || 0)) * 7.2;
        const out = `<rect x="${x}" y="16" width="${w}" height="30" rx="3" fill="${toneFill(seg.tone)}"/><text class="${w > 140 ? "bvw" : "bv"}" x="${x + 10}" y="36">${escapeHtml(cleanClientText(seg.label))} ${escapeHtml(formatCellValue(seg.pct, "percent"))}</text>`;
        x += w + 2;
        return out;
      })
      .join("")}
  </svg>${block.caption ? `<p class="chart-cap">${escapeHtml(block.caption)}</p>` : ""}</div>`;
};

const renderDonut = (block) => {
  const segments = block.segments || [];
  let offset = 25;
  const circles = segments
    .map((seg) => {
      const dash = Math.max(0, Math.min(100, Number(seg.pct) || 0));
      const out = `<circle cx="100" cy="100" r="64" fill="none" stroke="${toneFill(seg.tone)}" stroke-width="24" stroke-dasharray="${dash} ${100 - dash}" stroke-dashoffset="${offset}"/>`;
      offset -= dash;
      return out;
    })
    .join("");
  return `<div class="chart donut-wrap"><svg viewBox="0 0 420 210" role="img" aria-label="${escapeHtml(block.center_label || "Donut chart")}">${circles}<text class="bv" x="100" y="105" text-anchor="middle">${escapeHtml(block.center_label || "")}</text></svg></div>`;
};

const renderFixSteps = (steps = []) => steps.length ? `<ol>${steps.map((s) => `<li>${markdown(s)}</li>`).join("")}</ol>` : "";

// Trend table — this audit vs the previous one, the subscription's reason to
// exist (a Claude chat can't remember last week). Change is colored by whether
// the metric moved in the good or bad direction.
const renderTrend = (block) => {
  const rows = block.rows || [];
  if (!rows.length) return "";
  const arrow = (tone) => (tone === "good" ? "▲" : tone === "bad" ? "▼" : "→");
  return `<table class="scorecard trend-table"><thead><tr><th>Metric</th><th class="num">Last audit</th><th class="num">This audit</th><th class="num">Change</th></tr></thead><tbody>${rows
    .map((r) => {
      const tone = ["good", "bad"].includes(r.tone) ? r.tone : "neutral";
      return `<tr><td>${escapeHtml(cleanClientText(r.metric))}</td><td class="num">${escapeHtml(String(r.previous ?? "—"))}</td><td class="num">${escapeHtml(String(r.current ?? "—"))}</td><td class="num"><span class="status-${tone}">${arrow(tone)} ${escapeHtml(String(r.change ?? ""))}</span></td></tr>`;
    })
    .join("")}</tbody></table>${block.caption ? `<p class="chart-cap">${escapeHtml(block.caption)}</p>` : ""}`;
};

// Phased roadmap — the strategic "how to get there over time" the client asked
// for, sequenced Phase 1 (stop the bleeding) → 2 (tighten) → 3 (structural).
const renderRoadmap = (block) => {
  const phases = block.phases || [];
  if (!phases.length) return "";
  return `<div class="roadmap">${phases
    .map(
      (ph) => `<div class="phase">
        <div class="phase-head"><span class="phase-no">${escapeHtml(cleanClientText(ph.label))}</span><span class="phase-time">${escapeHtml(cleanClientText(ph.timeframe))}</span></div>
        <p class="phase-goal">${markdown(ph.goal)}</p>
        <ol>${(ph.items || [])
          .map((it) => `<li>${markdown(it.action)}${it.effort ? ` <span class="phase-effort">${escapeHtml(cleanClientText(it.effort))}</span>` : ""}${it.result ? ` <span class="phase-result">${escapeHtml(cleanClientText(it.result))}</span>` : ""}</li>`)
          .join("")}</ol>
      </div>`
    )
    .join("")}</div>`;
};

// Per-campaign deep-dive card — a campaign's metric scorecard + verdict + next
// steps, matching the reference Claude audit's section-3 per-campaign tables.
const STATUS_SEV = { good: "sev-low", warn: "sev-medium", bad: "sev-critical", neutral: "sev-low" };
const renderCampaignCard = (block) => {
  const status = ["good", "warn", "bad"].includes(block.status) ? block.status : "neutral";
  return `<div class="finding ${STATUS_SEV[status] || "sev-low"}">
    <div class="finding-head">${block.status_label ? renderStatusPill(status, block.status_label) : ""}${block.spend ? `<span class="mono">${escapeHtml(String(block.spend))}</span>` : ""}</div>
    <h3>${escapeHtml(cleanClientText(block.name))}</h3>
    ${renderScorecard({ rows: block.metrics || [] })}
    ${block.verdict ? `<p class="takeaway">${markdown(block.verdict)}</p>` : ""}
    ${renderFixSteps(block.steps || [])}
  </div>`;
};

const renderCallout = (block) => {
  const text = String(block.text || "");
  if (!text.trim() || /\bundefined\b/i.test(text)) return "";
  if (/^\s*confidence:\s*(high|medium|low)\.\s*ease of implementation:/i.test(text)) return "";
  return `<div class="callout ${escapeHtml(block.tone || "info")}">${markdown(block.text)}</div>`;
};

const renderTakeaway = (block) => `<p class="takeaway">${markdown(block.text)}</p>`;

const renderFinding = (block) => `<div class="finding ${severityClass(block.severity)}">
  <div class="finding-head"><span class="tag ${severityClass(block.severity)}">${escapeHtml(cleanClientText(block.severity))}</span>${block.confidence ? `<span class="mono">Confidence: ${escapeHtml(sentenceCase(block.confidence))}</span>` : ""}${block.ease ? `<span class="mono">Ease: ${escapeHtml(sentenceCase(block.ease))}</span>` : ""}</div>
  <h3>${escapeHtml(cleanClientText(block.headline))}</h3>
  ${(block.body_blocks || []).map(renderBlock).join("")}
  ${renderFixSteps(block.fix_steps || [])}
</div>`;

export const renderBlock = (block) => {
  if (!block || !block.type) return "";
  if (block.type === "paragraph") return `<p>${markdown(block.text)}</p>`;
  if (block.type === "pull_quote") return `<div class="verdict"><p>${markdown(block.text)}</p></div>`;
  if (block.type === "bar_chart_h") return renderHorizontalBars(block);
  if (block.type === "bar_chart_v") return renderVerticalBars(block);
  if (block.type === "line_chart") return renderLineChart(block);
  if (block.type === "comparison_bars") return `${renderHorizontalBars({ ...block, allowFewRows: true, gridlines: false, caption: block.annotation?.text })}`;
  if (block.type === "composition_bar") return renderCompositionBar(block);
  if (block.type === "donut") return renderDonut(block);
  if (block.type === "evidence_table") return renderEvidenceTable(block);
  if (block.type === "data_table") return renderDataTable(block);
  if (block.type === "scorecard") return renderScorecard(block);
  if (block.type === "trend") return renderTrend(block);
  if (block.type === "roadmap") return renderRoadmap(block);
  if (block.type === "campaign_card") return renderCampaignCard(block);
  if (block.type === "finding") return renderFinding(block);
  if (block.type === "fix_steps") return renderFixSteps(block.steps || []);
  if (block.type === "takeaway") return renderTakeaway(block);
  if (block.type === "score_gauge") return renderScoreGauge(block.score, block.score_band, block.caption);
  if (block.type === "callout") return renderCallout(block);
  return "";
};

const renderSection = (section, index) => {
  const blocks = (section.blocks || []).map(renderBlock).filter(Boolean);
  if (!blocks.length) return "";
  return `<section class="section" id="${escapeHtml(section.id)}">
    <div class="section-rule"><span class="no">${String(index + 1).padStart(2, "0")}</span><span class="ln"></span></div>
    <div class="eyebrow">${escapeHtml(cleanClientText(section.eyebrow))}</div>
    <h2>${escapeHtml(cleanClientText(section.title))}</h2>
    ${section.intro ? `<p>${markdown(section.intro)}</p>` : ""}
    ${blocks.join("")}
  </section>`;
};

// A section appears in the body only when it has at least one renderable block
// (renderSection returns "" otherwise). The TOC must use the SAME test, and the
// SAME index-based numbering, so a contents entry can never point at a section
// that didn't render or show a number that disagrees with the body.
const sectionWillRender = (section) =>
  (section?.blocks || []).map(renderBlock).filter(Boolean).length > 0;

/**
 * Table of contents — a clickable index at the front of the report.
 *
 * Entries are built from the document model, so titles and the two-digit section
 * numbers are exact and always match the body. No page numbers: headless Chrome
 * can't resolve them in a single render pass and naive estimates drift across the
 * report's break-inside:avoid blocks — wrong numbers would be worse than none.
 * Each row is an in-document anchor, which Chrome turns into a clickable internal
 * link in the PDF.
 */
const renderTableOfContents = (doc) => {
  const entries = [];
  if (doc.executive_summary) {
    entries.push({ no: "", id: "executive-summary", label: "Executive Summary", sub: "What this audit found" });
  }
  (doc.sections || []).forEach((section, index) => {
    if (!sectionWillRender(section)) return;
    // The eyebrow is the short, scannable section name a reader looks for
    // (Health Score, Money Map, Findings…); the title is its descriptive line.
    entries.push({
      no: String(index + 1).padStart(2, "0"),
      id: section.id,
      label: cleanClientText(section.eyebrow) || cleanClientText(section.title),
      sub: cleanClientText(section.eyebrow) ? cleanClientText(section.title) : "",
    });
  });
  if ((doc.method_notes || []).length) {
    entries.push({ no: "MT", id: "method", label: "Method", sub: "Benchmarks, confidence & assumptions" });
  }
  // Nothing to navigate — don't add a contents page to a one-section report.
  if (entries.length < 3) return "";

  return `<section class="section toc" id="table-of-contents">
    <div class="section-rule"><span class="no">··</span><span class="ln"></span></div>
    <div class="eyebrow">Contents</div>
    <h2>What's in this report</h2>
    <nav class="toc-list">${entries
      .map(
        (e) =>
          `<a class="toc-row" href="#${escapeHtml(e.id)}"><span class="toc-no">${escapeHtml(e.no || "—")}</span><span class="toc-text"><span class="toc-label">${escapeHtml(e.label)}</span>${e.sub ? `<span class="toc-sub">${escapeHtml(e.sub)}</span>` : ""}</span></a>`
      )
      .join("")}</nav>
  </section>`;
};

// The week-one Action Plan is no longer rendered separately — the phased
// Roadmap (Phase 1 = this week) is the single action home, with per-item effort
// + recoverable. The `action_plan` field stays on the document for schema
// validity and API consumers.

const renderMethod = (notes = []) =>
  notes.length
    ? `<section class="section method" id="method"><div class="section-rule"><span class="no">MT</span><span class="ln"></span></div><div class="eyebrow">Method</div><h2>Benchmarks, confidence & assumptions</h2><ul>${notes
        .map((n) => `<li><b>${escapeHtml(cleanClientText(n.label))}.</b> ${escapeHtml(cleanClientText(n.text))}</li>`)
        .join("")}</ul></section>`
    : "";

export const premiumReportStyles = `.brand-logo{max-height:48px;max-width:180px;object-fit:contain;display:block}:root{--ink:#16211B;--soft:#46524B;--muted:#7C857F;--faint:#A8AFA9;--line:#E6E8E3;--line-strong:#16211B;--brand:#1B5742;--brand-deep:#0F3A2C;--money:#0E7A4F;--money-bg:#EBF5EF;--amber:#B26A12;--amber-fill:#D29A4A;--amber-bg:#FBF3E6;--red:#B3261E;--red-bg:#FBEAE9;--paper:#FFFFFF;--paper-tint:#FBFBF8}*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',system-ui,sans-serif;color:var(--ink);background:var(--paper-tint);font-size:15px;line-height:1.7;-webkit-font-smoothing:antialiased}.sheet{max-width:820px;margin:40px auto;background:var(--paper);box-shadow:0 1px 2px rgba(22,33,27,.05),0 12px 40px rgba(22,33,27,.07);border:1px solid var(--line)}.pad{padding:0 72px}.masthead{background:var(--brand-deep);color:#fff;padding:48px 72px 44px;position:relative;overflow:hidden}.masthead:after{content:'';position:absolute;right:-80px;top:-80px;width:340px;height:340px;border-radius:50%;border:1px solid rgba(255,255,255,.10);box-shadow:0 0 0 48px rgba(255,255,255,.04),0 0 0 110px rgba(255,255,255,.03)}.mast-brand{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:40px;position:relative;z-index:1}.logo{font:600 15px 'Inter';letter-spacing:.02em}.doc-type{font:600 11px 'IBM Plex Mono';letter-spacing:.14em;text-transform:uppercase;color:#9DBFAE}.mast-grid{display:grid;grid-template-columns:1fr auto;gap:40px;align-items:end;position:relative;z-index:1}.mast-title h1{font:600 34px/1.18 'Fraunces',serif;letter-spacing:-.015em;margin-bottom:18px}.mast-sub{font-size:14px;color:#BBCFC2;max-width:430px}.gauge{text-align:center}.gauge svg{display:block;margin:0 auto 4px}.g-num{font:700 38px/1 'Fraunces';fill:#fff}.g-of{font:500 11px 'IBM Plex Mono';fill:#9DBFAE}.g-band{display:inline-block;font:600 11px 'Inter';letter-spacing:.06em;text-transform:uppercase;padding:4px 14px;border-radius:99px;background:rgba(210,154,74,.18);color:#E8C285;border:1px solid rgba(232,194,133,.35)}.mast-meta{display:flex;flex-wrap:wrap;gap:8px 36px;margin-top:36px;padding-top:22px;border-top:1px solid rgba(255,255,255,.14);font-size:12.5px;color:#9DBFAE;position:relative;z-index:1}.mast-meta b{color:#fff;font-weight:600;margin-left:6px}.keystrip{display:grid;grid-template-columns:repeat(4,1fr);border-bottom:1px solid var(--line)}.kcell{padding:26px 20px 22px;text-align:center}.kcell+.kcell{border-left:1px solid var(--line)}.kcell b{display:block;font:600 26px 'Fraunces';letter-spacing:-.01em}.kcell b.good,.highlight{color:var(--money)}.kcell b.warn{color:var(--amber)}.kcell span{font-size:11.5px;color:var(--muted);font-weight:500;letter-spacing:.02em}.body-wrap{padding-top:56px;padding-bottom:72px}.eyebrow{font:600 11px 'IBM Plex Mono';letter-spacing:.16em;text-transform:uppercase;color:var(--brand);margin-bottom:10px}h2{font:600 24px/1.25 'Fraunces',serif;letter-spacing:-.01em;margin:0 0 16px}.section{margin-bottom:64px}.section-rule{display:flex;align-items:center;gap:14px;margin-bottom:28px}.section-rule .no{font:600 13px 'IBM Plex Mono';color:var(--faint)}.section-rule .ln{flex:1;height:1px;background:var(--line)}h3{font:600 17px 'Fraunces',serif;margin:20px 0 10px}p{margin:0 0 15px;color:var(--soft)}p b,li b{color:var(--ink);font-weight:600}.small{font-size:12.5px;color:var(--muted)}.mono{font-family:'IBM Plex Mono',monospace;font-size:.9em}.verdict{margin:8px 0 30px;padding:26px 30px;background:var(--money-bg);border-radius:4px;border-left:4px solid var(--money)}.verdict p{font:500 18px/1.55 'Fraunces',serif;color:var(--ink);margin:0}table{width:100%;border-collapse:collapse;margin:18px 0 10px;font-size:13.5px}th{text-align:left;font:600 11px 'Inter';text-transform:uppercase;letter-spacing:.08em;color:var(--muted);border-bottom:2px solid var(--line-strong);padding:9px 14px 9px 0}td{border-bottom:1px solid var(--line);padding:12px 14px 12px 0;vertical-align:top;color:var(--soft)}tr:last-child td{border-bottom:2px solid var(--line-strong)}td.num,th.num{text-align:right;font:500 12.5px 'IBM Plex Mono';white-space:nowrap}.tnote{font-size:12px;color:var(--muted);margin-bottom:24px}.tag{display:inline-block;font:600 10.5px 'Inter';letter-spacing:.04em;padding:2px 9px;border-radius:99px;background:var(--amber-bg);color:var(--amber)}.tag.sev-critical{background:var(--red-bg);color:var(--red)}.tag.sev-high{background:#FFF1E7;color:#C2410C}.tag.sev-low{background:#F3F4F6;color:#4B5563}.chart{margin:26px 0 12px}.chart svg{display:block;width:100%;height:auto}.chart-cap{font-size:12px;color:var(--muted);margin-bottom:22px}.bl{font:500 12.5px 'Inter';fill:var(--soft)}.bv{font:600 12px 'IBM Plex Mono';fill:var(--ink)}.bvw{font:600 12px 'IBM Plex Mono';fill:#fff}.grid{stroke:#EFF0EC;stroke-width:1}.ax{stroke:var(--ink);stroke-width:1.5}.projection{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;margin:26px 0 8px;border-top:2px solid var(--line-strong);border-bottom:2px solid var(--line-strong)}.proj-cell{padding:20px 22px;display:flex;flex-direction:column;gap:2px}.proj-cell+.proj-cell{border-left:1px solid var(--line)}.proj-cell small{font:600 10.5px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}.proj-cell b{font:600 24px 'Fraunces';color:var(--money)}.proj-cell span{font-size:12px;color:var(--muted)}.finding{padding:22px 0;border-top:1px solid var(--line)}.finding-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}.callout{margin:18px 0;padding:12px 14px;border-radius:4px;background:#F3F4F6;color:var(--soft);border-left:3px solid #9CA3AF}.callout.warn{background:var(--amber-bg);border-color:var(--amber);color:#7A4B0D}.callout.good{background:var(--money-bg);border-color:var(--money);color:#234B39}.callout.info{background:#EFF6FF;border-color:#3B82F6;color:#1F3B63}ol,ul{margin:0 0 16px 22px;color:var(--soft)}li{margin:6px 0}.doc-foot{border-top:2px solid var(--line-strong);margin-top:8px;padding:22px 0 0;display:flex;justify-content:space-between;gap:20px;font-size:12px;color:var(--muted);flex-wrap:wrap}.doc-foot b{color:var(--ink)}@media(max-width:760px){.pad{padding:0 24px}.sheet{margin:0}.masthead{padding:36px 24px}.mast-grid{grid-template-columns:1fr}.keystrip{grid-template-columns:repeat(2,1fr)}.kcell:nth-child(3){border-left:none}.projection{grid-template-columns:1fr}.proj-cell+.proj-cell{border-left:none;border-top:1px solid var(--line)}}@media print{body{background:#fff}.sheet{margin:0;box-shadow:none;border:none;max-width:100%}h2,h3{break-after:avoid}table,svg,.verdict,.projection,.finding{break-inside:avoid}.masthead:after{display:none}}`;

const embeddedReportOverrides = `html,body{width:100%;max-width:100%;overflow-x:hidden}body{background:#f7f4ef}.sheet{width:calc(100% - 56px);max-width:1160px;margin:28px auto 64px;border:1px solid #E3DED4;border-radius:18px;box-shadow:0 18px 60px rgba(22,33,27,.08);overflow:hidden}.pad{padding-left:clamp(28px,5vw,72px);padding-right:clamp(28px,5vw,72px)}.masthead{padding:42px clamp(28px,5vw,72px) 38px}.masthead:after{right:-130px;top:-120px;opacity:.65}.mast-grid{grid-template-columns:minmax(0,1fr) 180px;align-items:center;gap:36px}.mast-title h1{max-width:760px;font-size:clamp(30px,4vw,46px);line-height:1.08;letter-spacing:0}.mast-sub{max-width:640px;font-size:15px;line-height:1.65}.mast-title,.mast-title h1,.mast-sub,p,h1,h2,h3,li,td,th{overflow-wrap:break-word;word-break:normal}.mast-meta{gap:10px 28px}.keystrip{grid-template-columns:repeat(4,minmax(0,1fr));background:#fff}.kcell{min-width:0;padding:24px 18px}.kcell b{font-size:clamp(22px,2.6vw,30px);overflow-wrap:break-word}.body-wrap{padding-top:54px}.section{margin-bottom:72px}.section-rule{margin-bottom:22px}.verdict{padding:24px 26px;border-radius:10px}.verdict p{font-size:clamp(18px,2vw,22px);line-height:1.55}table{table-layout:auto;max-width:100%;font-size:13px}td,th{overflow-wrap:break-word;word-break:normal}td.num,th.num{white-space:normal;text-align:right;min-width:112px}.chart{max-width:100%;overflow:hidden;border:1px solid #ECE8DE;border-radius:14px;background:#fff;padding:18px 18px 8px;margin:24px 0 14px}.chart svg{max-width:100%;height:auto}.chart-cap{padding:0 4px}.finding{border:1px solid #ECE8DE;border-radius:14px;background:#fff;padding:22px 24px;margin:18px 0;box-shadow:0 8px 24px rgba(22,33,27,.035)}.finding:first-of-type{border-color:#D9B16D}.finding h3{font-size:21px}.callout{border-radius:10px}.projection{border:1px solid #E3DED4;border-radius:14px;overflow:hidden}.proj-cell+.proj-cell{border-left:1px solid #E3DED4}@media(max-width:900px){.sheet{width:calc(100% - 28px);margin:14px auto 40px;border-radius:12px}.mast-grid{grid-template-columns:1fr}.gauge{text-align:left}.gauge svg{margin-left:0}.keystrip{grid-template-columns:repeat(2,minmax(0,1fr))}.kcell:nth-child(3){border-left:none}.mast-meta{display:grid;grid-template-columns:1fr}.pad{padding-left:22px;padding-right:22px}.masthead{padding-left:22px;padding-right:22px}td.num,th.num{text-align:left}.projection{grid-template-columns:1fr}.proj-cell+.proj-cell{border-left:none;border-top:1px solid #E3DED4}}@media(max-width:640px){.keystrip{grid-template-columns:1fr}.kcell+.kcell{border-left:none;border-top:1px solid var(--line)}table,thead,tbody,tr,td,th{display:block;width:100%}thead{display:none}td{padding:10px 0}tr{padding:12px 0;border-bottom:1px solid var(--line)}tr:last-child td{border-bottom:0}}`;

const premiumPolishOverrides = `.status-pill{display:inline-block;font:600 10.5px 'Inter';letter-spacing:.03em;padding:2px 10px;border-radius:99px;white-space:nowrap}.status-good{background:var(--money-bg);color:var(--money)}.status-warn{background:var(--amber-bg);color:var(--amber)}.status-bad{background:var(--red-bg);color:var(--red)}.status-neutral{color:var(--faint)}.scorecard td:first-child{color:var(--ink);font-weight:500}.roadmap{margin:18px 0 8px}.phase{border:1px solid #ECE8DE;border-left:3px solid var(--brand);border-radius:10px;padding:16px 22px;margin:14px 0;background:#fff;break-inside:avoid}.phase-head{display:flex;align-items:baseline;gap:12px;margin-bottom:8px}.phase-no{font:600 15px 'Fraunces',serif;color:var(--ink)}.phase-time{font:600 10.5px 'IBM Plex Mono';letter-spacing:.1em;text-transform:uppercase;color:var(--brand)}.phase-goal{margin:0 0 10px;color:var(--soft)}.phase ol{margin:0 0 2px 20px}.phase-result{color:var(--money);font-weight:600;font-size:.9em;white-space:nowrap}.phase-effort{display:inline-block;font:600 10px 'IBM Plex Mono';letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:#F3F4F6;border-radius:4px;padding:1px 7px;margin-left:4px}.section{margin-bottom:82px}.eyebrow{color:var(--muted)}.num{font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}p .num,.verdict .num,.mast-sub .num{font-weight:700;color:var(--money)}.score-gauge-card{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:24px;border:1px solid #ECE8DE;border-radius:14px;background:#fff;padding:20px 22px;margin:24px 0}.score-gauge-card .g-num{fill:var(--ink)}.score-gauge-card .g-of{fill:var(--muted)}.score-gauge-card .gauge path:first-child{stroke:#E8EAE4}.score-gauge-card .small{margin:0}.finding{position:relative;padding-left:30px}.finding:before{content:'';position:absolute;left:16px;top:24px;width:3px;height:34px;border-radius:99px;background:#9CA3AF}.finding.sev-critical:before{background:var(--red)}.finding.sev-high:before{background:#C2410C}.finding.sev-medium:before{background:var(--amber)}.finding.sev-low:before{background:#9CA3AF}.finding-head{flex-wrap:wrap;color:var(--muted)}.finding-head .mono{color:var(--muted);font-size:11px;letter-spacing:.02em}.takeaway{font:500 17px/1.55 'Fraunces',serif;color:var(--ink);border-left:3px solid var(--money);padding-left:14px;margin:20px 0 18px}.evidence-table td.num{max-width:190px}.method{margin-top:36px}.toc-list{margin:20px 0 4px;border-top:2px solid var(--line-strong)}.toc-row{display:flex;align-items:baseline;gap:16px;padding:14px 2px;border-bottom:1px solid var(--line);text-decoration:none;color:var(--ink)}.toc-no{flex:0 0 auto;min-width:30px;font:600 12px 'IBM Plex Mono';letter-spacing:.04em;color:var(--brand)}.toc-text{flex:1 1 auto;display:flex;flex-direction:column;gap:2px}.toc-label{font:500 15.5px 'Fraunces',serif;letter-spacing:-.005em;color:var(--ink)}.toc-sub{font-size:12.5px;color:var(--muted)}.toc-row:hover .toc-label{color:var(--brand)}.toc{break-after:page}@media(max-width:640px){.score-gauge-card{grid-template-columns:1fr}.finding{padding-left:24px}.finding:before{left:12px}.toc-no{min-width:26px}}`;

// PDF export renders the same document but skips the "embedded" web overrides
// (rounded card, drop shadow, large outer margins) which fight with print
// pagination and leave large blank gaps between pages. Print rules already
// defined in premiumReportStyles handle full-bleed layout for @media print.
const pdfOverrides = `body{background:#fff;font-size:13.5px}.sheet{margin:0;max-width:100%;box-shadow:none;border:none}.pad{padding:0 40px}.masthead{padding:34px 40px 30px}.masthead:after{display:none}.mast-title h1{font-size:28px}.mast-grid{gap:28px}.body-wrap{padding-top:36px;padding-bottom:30px}.section{margin-bottom:38px}.keystrip{break-inside:avoid}`;

const docFootHtml = (branding = {}) => {
  const name = escapeHtml(branding.companyName || "AdAdviser");
  const right = branding.website
    ? `<a href="${escapeHtml(branding.website)}" style="color:inherit;text-decoration:none">${escapeHtml(branding.website)}</a>`
    : "Figures come from verified account data · narrative explains the evidence";
  return `<div class="doc-foot"><span><b>${name}</b> · AI-powered PPC audits</span><span>${right}</span></div>`;
};

export const renderReport = (doc, branding = {}) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AdAdviser Performance Audit</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet"><style>${premiumReportStyles}${embeddedReportOverrides}${premiumPolishOverrides}</style></head><body><div class="sheet">${renderMasthead(doc, branding)}${renderKeyNumbers(doc.key_numbers)}<div class="pad body-wrap">${renderTableOfContents(doc)}${renderExecutiveSummary(doc.executive_summary)}${(doc.sections || []).map(renderSection).join("")}${renderMethod(doc.method_notes)}${docFootHtml(branding)}</div></div></body></html>`;

export const renderReportForPdf = (doc, branding = {}) => {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>AdAdviser Performance Audit</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet"><style>${premiumReportStyles}${premiumPolishOverrides}${pdfOverrides}</style></head><body><div class="sheet">${renderMasthead(doc, branding)}${renderKeyNumbers(doc.key_numbers)}<div class="pad body-wrap">${renderTableOfContents(doc)}${renderExecutiveSummary(doc.executive_summary)}${(doc.sections || []).map(renderSection).join("")}${renderMethod(doc.method_notes)}${docFootHtml(branding)}</div></div></body></html>`;
};

export const renderAuditPremiumReportHtml = (audit, branding = {}) => renderReport(buildReportDocumentFromAudit(audit), branding);
