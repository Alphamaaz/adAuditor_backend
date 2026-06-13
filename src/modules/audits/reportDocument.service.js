const platformDocLabels = {
  GOOGLE: "google_ads",
  META: "meta_ads",
  TIKTOK: "tiktok_ads",
};

const platformLabels = {
  GOOGLE: "Google Ads",
  META: "Meta Ads",
  TIKTOK: "TikTok Ads",
};

const severityWeight = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
const confidenceWeight = { high: 3, medium: 2, low: 1 };
const easeWeight = { easy: 3, medium: 2, hard: 1 };

export const reportDocumentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["masthead", "key_numbers", "executive_summary", "sections", "action_plan", "method_notes"],
  properties: {
    masthead: { type: "object" },
    key_numbers: { type: "array", minItems: 3, maxItems: 4 },
    executive_summary: { type: "object" },
    sections: { type: "array" },
    action_plan: { type: "object" },
    method_notes: { type: "array" },
  },
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const moneyMagnitude = (value) => {
  if (value === null || value === undefined) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const match = text.match(/(?:\$|[A-Z]{3})\s?([\d,]+(?:\.\d+)?)/i);
  return match ? Number(match[1].replace(/,/g, "")) || 0 : 0;
};

const formatMoney = (value, currency = "USD") => {
  const rounded = Math.round(num(value));
  const formatted = rounded.toLocaleString("en-US");
  return `${String(currency || "USD").toUpperCase()} ${formatted}`;
};

const impactLabel = (finding, currency = "USD") => {
  const amount = moneyMagnitude(finding.estimatedImpact || finding.evidence);
  if (amount > 0) return `${formatMoney(amount, currency)} recoverable`;
  const text = String(finding.estimatedImpact || "").trim();
  const context = `${finding.title || ""} ${finding.detail || ""} ${text}`;
  if (/not quantified|impact not quantifiable|not safely quantifiable/i.test(text)) {
    if (/paused|inactive|zero impression|keyword/i.test(context)) return "Account hygiene risk";
    if (/brand/i.test(context)) return "Brand risk";
    if (/tracking|pixel|capi/i.test(context)) return "Tracking risk";
    return "Business risk";
  }
  if (!text) {
    if (/paused|inactive|zero impression|keyword/i.test(context)) return "Account hygiene risk";
    if (/brand/i.test(context)) return "Brand risk";
    if (/tracking|pixel|capi/i.test(context)) return "Tracking risk";
    return "Needs review";
  }
  if (text.length <= 42) return text;
  if (/brand/i.test(context)) return "Brand risk";
  if (/keyword|impression|paused|inactive/i.test(context)) return "Account hygiene risk";
  if (/tracking|pixel|capi/i.test(context)) return "Tracking risk";
  return "Needs review";
};

const titleize = (value) =>
  String(value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

const cleanReportText = (value) =>
  titleize(value)
    .replace(/\bDay Of Week\b/g, "Day of week")
    .replace(/\bCpa\b/g, "CPA")
    .replace(/\bCtr\b/g, "CTR")
    .replace(/\bCpc\b/g, "CPC")
    .replace(/\bRoas\b/g, "ROAS")
    .replace(/\b(Pkr|Usd|Eur|Gbp|Aed|Inr|Cad|Aud|Nzd|Sgd|Sar|Try|Jpy|Zar)\b/g, (m) =>
      m.toUpperCase()
    );

const cleanSegmentValue = (value) => {
  const text = String(value ?? "").replace(/[_-]+/g, " ").trim();
  if (/^[A-Z][A-Z\s]+$/.test(text)) return text.toLowerCase().replace(/^./, (c) => c.toUpperCase());
  return cleanReportText(text);
};

const escapePlain = (value, fallback = "") =>
  String(value ?? fallback)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const scoreBand = (score) => {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 55) return "Fair";
  if (score >= 35) return "Poor";
  return "Critical";
};

const getCurrency = (audit) => {
  const summary = audit.normalizedDataset?.summary || {};
  const platforms = summary.platforms || {};
  for (const platform of Object.values(platforms)) {
    if (platform?.currency) return platform.currency;
  }
  return summary.totals?.currency || "USD";
};

const getTotals = (audit) => {
  const summary = audit.normalizedDataset?.summary || {};
  const totals = summary.totals || {};
  if (totals.spend || totals.impressions || totals.clicks || totals.conversions) return totals;
  const data = audit.normalizedDataset?.data || {};
  const byPlatform = data.byPlatform || {};
  return Object.values(byPlatform).reduce(
    (acc, platform) => {
      const s = platform.summary || {};
      acc.spend += num(s.spend);
      acc.impressions += num(s.impressions);
      acc.clicks += num(s.clicks);
      acc.conversions += num(s.conversions ?? s.results);
      return acc;
    },
    { spend: 0, impressions: 0, clicks: 0, conversions: 0 }
  );
};

const findingConfidence = (finding) => {
  const raw = String(finding.evidence?.confidence || "").toLowerCase();
  if (["high", "medium", "low"].includes(raw)) return raw;
  if (String(finding.evidence?.sampleNote || "").toLowerCase().includes("low")) return "low";
  return finding.severity === "CRITICAL" || finding.severity === "HIGH" ? "high" : "medium";
};

const findingEase = (finding) => {
  const text = `${finding.title || ""} ${finding.detail || ""}`.toLowerCase();
  if (text.includes("tracking") || text.includes("pixel") || text.includes("capi")) return "hard";
  return Array.isArray(finding.fixSteps) && finding.fixSteps.length > 3 ? "medium" : "easy";
};

export const sortFindingsForReport = (findings = []) =>
  [...findings].sort((a, b) => {
    const money = moneyMagnitude(b.estimatedImpact || b.evidence) - moneyMagnitude(a.estimatedImpact || a.evidence);
    if (money !== 0) return money;
    const conf = confidenceWeight[findingConfidence(b)] - confidenceWeight[findingConfidence(a)];
    if (conf !== 0) return conf;
    const ease = easeWeight[findingEase(b)] - easeWeight[findingEase(a)];
    if (ease !== 0) return ease;
    return (severityWeight[b.severity] || 0) - (severityWeight[a.severity] || 0);
  });

const categoryScoreRows = (audit) => {
  const scores = audit.categoryScores || {};
  const rows = [];
  const walk = (value, path = []) => {
    if (typeof value === "number" && value >= 0 && value <= 100) {
      const last = path[path.length - 1];
      if (/^(overall|score|findingCount)$/i.test(last || "")) return;
      const categoryIndex = path.findIndex((p) => p === "categories");
      const labelPath = categoryIndex >= 0 ? path.slice(categoryIndex + 1) : path;
      const label = labelPath.join(" ");
      rows.push({ label: label || "Score", value });
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    Object.entries(value).forEach(([key, child]) => walk(child, [...path, key]));
  };
  walk(scores);
  return rows
    .filter((row) => row.label && !/^platforms$/i.test(row.label))
    .slice(0, 10)
    .map(({ label, value }) => ({
      label: cleanReportText(label),
      value,
      max: 100,
      tone: value < 85 ? "warn" : "brand",
      display: String(value),
    }));
};

const hiddenEvidenceKeys = new Set(["id", "ruleId", "rule_id", "module", "version", "currency", "dimension"]);

const evidenceValue = (key, value, currency) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (/pct|percent|rate/i.test(key)) return `${Number(value.toFixed(1)).toLocaleString("en-US")}%`;
    if (/(spend|waste|cost|cpa|cpc|budget|revenue|impact|recoverable)/i.test(key)) return formatMoney(value, currency);
    return Math.round(value).toLocaleString("en-US");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (/segment|day|network|device|placement|reason/i.test(key)) return cleanSegmentValue(value);
  return String(value);
};

const isShortEvidenceValue = (value) => {
  const text = String(value || "").trim();
  if (!text || text.length > 24) return false;
  if (/\.\s+\S/.test(text)) return false;
  if (text.split(/\s+/).filter(Boolean).length > 6) return false;
  return true;
};

const evidenceRows = (finding, currency = "USD", proseContext = "") => {
  const evidence = finding.evidence && typeof finding.evidence === "object" ? finding.evidence : {};
  const rows = Object.entries(evidence)
    .filter(([key, value]) =>
      value !== null &&
      value !== undefined &&
      typeof value !== "object" &&
      !hiddenEvidenceKeys.has(key) &&
      !key.startsWith("_") &&
      !key.startsWith("internal_") &&
      !key.startsWith("raw_")
    )
    .map(([metric, value]) => ({
      metric: cleanReportText(metric),
      value: evidenceValue(metric, value, currency),
      highlight: moneyMagnitude(value) > 0 || /confidence/i.test(metric),
    }))
    .filter((row) => isShortEvidenceValue(row.value))
    .filter((row) => !proseContext || !proseContext.includes(row.value));
  const amount = moneyMagnitude(finding.estimatedImpact || finding.evidence);
  if (amount > 0) rows.unshift({ metric: "Recoverable spend", value: formatMoney(amount, currency), highlight: true });
  return rows.slice(0, 6);
};

const pickFirstNumber = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const match = value.match(/([\d,]+(?:\.\d+)?)/);
      if (match) {
        const parsed = Number(match[1].replace(/,/g, ""));
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return null;
};

const chartForFinding = (finding, currency = "USD") => {
  const e = finding.evidence || {};
  if (e.currentCtr && e.peerCtr) {
    return {
      type: "comparison_bars",
      rows: [
        { label: "This account CTR", value: num(e.currentCtr), max: Math.max(num(e.currentCtr), num(e.peerCtr)), tone: "warn", display: `${e.currentCtr}%` },
        { label: "Peer CTR", value: num(e.peerCtr), max: Math.max(num(e.currentCtr), num(e.peerCtr)), tone: "brand", display: `${e.peerCtr}%` },
      ],
      annotation: e.ctrGapPct ? { text: `${e.ctrGapPct}% gap` } : undefined,
    };
  }
  if (e.currentCpa && e.previousCpa) {
    return {
      type: "comparison_bars",
      rows: [
        { label: "Current CPA", value: num(e.currentCpa), max: Math.max(num(e.currentCpa), num(e.previousCpa)), tone: "warn", display: formatMoney(e.currentCpa, currency) },
        { label: "Previous CPA", value: num(e.previousCpa), max: Math.max(num(e.currentCpa), num(e.previousCpa)), tone: "brand", display: formatMoney(e.previousCpa, currency) },
      ],
    };
  }
  const segmentCpa = pickFirstNumber(e, [
    "segmentCpa",
    "segmentCPA",
    "segmentCost",
    "segmentCostPerConversion",
    "currentCpa",
    "currentCPA",
    "actualCpa",
    "actualCPA",
    "cpa",
  ]);
  const baselineCpa = pickFirstNumber(e, [
    "baselineCpa",
    "baselineCPA",
    "accountBaselineCpa",
    "accountBaselineCPA",
    "benchmarkCpa",
    "benchmarkCPA",
    "targetCpa",
    "targetCPA",
  ]);
  if (segmentCpa && baselineCpa) {
    const max = Math.max(segmentCpa, baselineCpa);
    return {
      type: "comparison_bars",
      rows: [
        { label: `${cleanSegmentValue(e.segment || e.dimension || "Segment")} CPA`, value: segmentCpa, max, tone: "warn", display: formatMoney(segmentCpa, currency) },
        { label: "Baseline CPA", value: baselineCpa, max, tone: "brand", display: formatMoney(baselineCpa, currency) },
      ],
      annotation: moneyMagnitude(finding.estimatedImpact) ? { text: impactLabel(finding, currency) } : undefined,
    };
  }
  const wasted = pickFirstNumber(e, [
    "estimatedWaste",
    "wastedSpend",
    "lossMakingSpend",
    "recoverableSpend",
  ]) || moneyMagnitude(finding.estimatedImpact);
  const spend = pickFirstNumber(e, ["spend", "segmentSpend", "totalSpend"]);
  if (wasted && spend && spend >= wasted) {
    return {
      type: "composition_bar",
      segments: [
        { label: "Recoverable", pct: Math.round((wasted / spend) * 1000) / 10, tone: "warn" },
        { label: "Remaining", pct: Math.max(0, Math.round((100 - (wasted / spend) * 100) * 10) / 10), tone: "brand" },
      ],
      caption: `${impactLabel(finding, currency)} within the affected spend pool.`,
    };
  }
  if (Array.isArray(e.rows) && e.rows.length >= 2 && e.rows.length <= 12) {
    return {
      type: "bar_chart_v",
      rows: e.rows.slice(0, 12).map((r) => ({
        label: String(r.label ?? r.segment ?? ""),
        value: num(r.value ?? r.spend ?? r.cpa),
        max: Math.max(...e.rows.map((x) => num(x.value ?? x.spend ?? x.cpa))),
        tone: "warn",
        display: String(r.display ?? r.value ?? r.spend ?? r.cpa),
      })),
      caption: finding.title,
    };
  }
  return null;
};

const takeawayForFinding = (finding, currency) => {
  const amount = moneyMagnitude(finding.estimatedImpact || finding.evidence);
  if (amount > 0) {
    return `What this means for you: fixing this can recover ${formatMoney(amount, currency)} in the next comparable period.`;
  }
  return "What this means for you: fixing this removes account drag before it turns into measurable waste.";
};

const findingBlock = (finding, currency = "USD") => {
  const impact = finding.estimatedImpact || "Business risk identified; the available data does not support a reliable money estimate.";
  const proseContext = `${finding.detail || finding.title} ${impact}`;
  const bodyBlocks = [
    {
      type: "paragraph",
      text: `**What is happening:** ${finding.detail || finding.title}`,
    },
    {
      type: "paragraph",
      text: "**Why it is happening:** the audit found this pattern in the account data. Use the evidence below to confirm the driver before changing budgets.",
    },
    {
      type: "paragraph",
      text: `**Estimated business impact:** ${impact}`,
    },
  ];
  const chart = chartForFinding(finding, currency);
  if (chart) bodyBlocks.push(chart);
  const rows = evidenceRows(finding, currency, proseContext);
  if (rows.length) bodyBlocks.push({ type: "evidence_table", rows, proseContext, currency });
  bodyBlocks.push({
    type: "paragraph",
    text: "**Expected outcome after fixing:** spend should shift away from the flagged weakness and performance should move closer to the account baseline.",
  });
  bodyBlocks.push({ type: "takeaway", text: takeawayForFinding(finding, currency) });

  return {
    type: "finding",
    id: null,
    severity: finding.severity,
    headline: finding.title,
    confidence: findingConfidence(finding),
    ease: findingEase(finding),
    body_blocks: bodyBlocks,
    fix_steps: Array.isArray(finding.fixSteps) && finding.fixSteps.length
      ? finding.fixSteps.slice(0, 5)
      : ["Review this issue in the ad platform and apply the recommended change.", "Re-run the audit after the next full reporting cycle."],
  };
};

const noFindingsDocument = ({ audit, currency, totals }) => ({
  masthead: {
    headline: "No measurable money leaks detected",
    subline: "The available data did not trigger any material performance findings.",
    platform: platformDocLabels[audit.selectedPlatforms?.[0]] || "google_ads",
    health_score: audit.healthScore ?? 100,
    score_band: scoreBand(audit.healthScore ?? 100),
    period: { start: null, end: audit.completedAt || audit.updatedAt || null },
    currency,
    tracking_verified: true,
  },
  key_numbers: [
    { value: "0", label: "Material findings", tone: "good" },
    { value: formatMoney(totals.spend || 0, currency), label: "Spend reviewed", tone: "neutral" },
    { value: String(Math.round(num(totals.conversions))), label: "Conversions reviewed", tone: "neutral" },
  ],
  executive_summary: {
    verdict: "No measurable money leak was detected in the available audit data.",
    paragraphs: [
      "**The account is clean from the available evidence.** The audit did not find a measured waste pattern, tracking break, or structural risk large enough to flag.",
      "**Keep monitoring.** Re-run the audit after the next reporting cycle so historical deltas can confirm the account stays stable.",
    ],
  },
  sections: [],
  action_plan: {
    title: "What to do this week, in order",
    intro: "No urgent fixes were detected. Keep the account under monitoring.",
    rows: [{ order: 1, action: "**Re-run after the next full cycle** to build trend history.", effort: "~5 min", result: "Trend baseline", result_tone: "neutral", links_to_finding: null }],
  },
  method_notes: [
    { label: "Honesty", text: "No impact is shown unless it is supported by deterministic rule evidence." },
  ],
});

export const buildReportDocumentFromAudit = (audit) => {
  const existing = audit.aiReport?.output?.premiumReport;
  if (existing && typeof existing === "object" && validateReportDocument(existing).isValid) return existing;

  const currency = getCurrency(audit);
  const totals = getTotals(audit);
  const findings = sortFindingsForReport(audit.ruleFindings || []);
  if (!findings.length) return noFindingsDocument({ audit, currency, totals });

  const top = findings[0];
  const topMoney = moneyMagnitude(top.estimatedImpact || top.evidence);
  const score = audit.healthScore ?? 0;
  const severityCounts = findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] || 0) + 1;
    return acc;
  }, {});
  const scoreRows = categoryScoreRows(audit);
  const quantified = findings.filter((f) => moneyMagnitude(f.estimatedImpact || f.evidence) > 0);
  const recoverable = quantified.reduce((sum, f) => sum + moneyMagnitude(f.estimatedImpact || f.evidence), 0);
  const platform = audit.selectedPlatforms?.[0] || top.platform || "GOOGLE";
  const platformLabel = platformLabels[platform] || "Paid Media";

  const sections = [];
  sections.push({
    id: "scores",
    eyebrow: "Health score",
    title: `Where the ${score} comes from`,
    intro:
      scoreRows.length >= 3
        ? "The score breakdown shows which account areas are healthy and which areas generated findings."
        : "The audit has an overall health score, but no reliable component-level breakdown for this run.",
    blocks:
      scoreRows.length >= 3
        ? [{ type: "bar_chart_h", kind: "score", score, score_band: scoreBand(score), rows: scoreRows, gridlines: true, caption: "Scores below 85 are treated as pressure points." }]
        : [{ type: "score_gauge", score, score_band: scoreBand(score), caption: "Component-level breakdown not available for this audit." }],
  });

  if (quantified.length > 0) {
    const maxImpact = Math.max(
      ...quantified.map((f) => moneyMagnitude(f.estimatedImpact || f.evidence)),
      1
    );
    sections.push({
      id: "money-map",
      eyebrow: "Money map",
      title: "Where the recoverable spend is concentrated",
      intro: "Only findings with measured financial evidence appear here. Structural risks stay out of this chart unless the engine can quantify them.",
      blocks: [
        {
          type: "bar_chart_h",
          rows: quantified.slice(0, 6).map((f) => {
            const value = moneyMagnitude(f.estimatedImpact || f.evidence);
            return {
              label: f.title,
              value,
              max: maxImpact,
              tone: f === top ? "warn" : "brand",
              display: formatMoney(value, currency),
            };
          }),
          gridlines: true,
          caption: "Measured recoverable spend by finding.",
        },
      ],
    });
  }

  sections.push({
    id: "findings",
    eyebrow: "Findings",
    title: `${findings.length} findings, ranked by impact`,
    intro: "Findings are ordered by measured recoverable spend or revenue first, then confidence, then ease of implementation.",
    blocks: [
      {
        type: "data_table",
        columns: [
          { header: "#", align: "left", width: "44px" },
          { header: "Finding", align: "left" },
          { header: "Severity", align: "left", width: "92px" },
          { header: "Impact", align: "right", width: "140px" },
        ],
        currency,
        rows: findings.slice(0, 8).map((f, i) => [
          String(i + 1),
          f.title,
          f.severity,
          impactLabel(f, currency),
        ]),
        footnote: "Money impact is shown only when the account data supports a reliable estimate. Other rows are still important business risks.",
      },
    ],
  });

  sections.push({
    id: "finding-detail",
    eyebrow: "Evidence",
    title: "The evidence, finding by finding",
    intro: "Each finding shows what is happening, the business impact, supporting evidence, confidence, and the recommended fix.",
    blocks: findings.slice(0, 6).map((finding) => findingBlock(finding, currency)),
  });

  const benchmarkComparisons = audit.aiReport?.output?.benchmarkComparisons || [];
  const validBenchmarkComparisons = benchmarkComparisons.filter(
    (item) => item && typeof item === "object" && item.label && item.finding
  );
  if (validBenchmarkComparisons.length) {
    sections.push({
      id: "benchmarks",
      eyebrow: "Benchmarks",
      title: "How this account compares",
      intro: "Benchmark comparisons appear only when peer, historical, or industry facts are available for this audit.",
      blocks: validBenchmarkComparisons.slice(0, 6).map((item) => ({
        type: "callout",
        tone: item.confidence === "high" ? "good" : "info",
        text: `**${item.label}:** ${item.finding}`,
      })),
    });
  }

  const projection = topMoney > 0
    ? {
        period_value: topMoney,
        quarterly: topMoney * 3,
        annualized: topMoney * 12,
        disclaimer: "Projection multiplies the measured period impact and assumes spend and performance patterns remain stable.",
      }
    : undefined;

  return {
    masthead: {
      headline: topMoney > 0 ? `${top.title}`.slice(0, 80) : `${platformLabel} needs cleanup`,
      subline: topMoney > 0
        ? `${top.estimatedImpact} is the clearest quantified opportunity in this audit.`
        : "The largest risks are structural and not safely quantifiable from available data.",
      platform: platformDocLabels[platform] || "google_ads",
      health_score: score,
      score_band: scoreBand(score),
      period: { start: null, end: audit.completedAt || audit.updatedAt || null },
      currency,
      tracking_verified: !findings.some((f) => /tracking|pixel|capi/i.test(`${f.title} ${f.detail}`)),
    },
    key_numbers: [
      { value: recoverable > 0 ? formatMoney(recoverable, currency) : "No quantified leak", label: recoverable > 0 ? "Recoverable this period" : "Measured money leaks", tone: recoverable > 0 ? "good" : "good" },
      { value: formatMoney(totals.spend || 0, currency), label: "Spend reviewed", tone: "neutral" },
      { value: String(Math.round(num(totals.conversions))), label: "Conversions reviewed", tone: "neutral" },
      { value: String(findings.length), label: `${severityCounts.CRITICAL || 0} critical · ${severityCounts.HIGH || 0} high`, tone: severityCounts.CRITICAL || severityCounts.HIGH ? "warn" : "neutral" },
    ],
    executive_summary: {
      verdict: topMoney > 0
        ? `${top.estimatedImpact} is the single most important number in this audit.`
        : `The biggest issue is ${top.title}. It is a business risk, but the available data does not support a reliable money estimate.`,
      paragraphs: [
        `**Lead issue:** ${top.title}. ${top.detail || top.estimatedImpact || "This is the highest-priority finding in the account data."}`,
        `**Why it matters:** Findings are ranked by recoverable spend/revenue, confidence, and implementation ease, not by severity label alone.`,
        "**Next move:** Start with the first issue in this report, then re-run the audit after the next full reporting cycle to measure the delta.",
      ],
      ...(projection ? { projection } : {}),
    },
    sections,
    action_plan: {
      title: "What to do this week, in order",
      intro: "This sequence prioritizes business impact first, then confidence and ease of implementation.",
      rows: findings.slice(0, 5).map((f, index) => ({
        order: index + 1,
        action: `**${f.title}:** ${(Array.isArray(f.fixSteps) && f.fixSteps[0]) || "Apply the recommended fix in the platform."}`,
        effort: findingEase(f) === "easy" ? "~1 hour" : findingEase(f) === "medium" ? "Half day" : "Technical",
        result: impactLabel(f, currency),
        result_tone: moneyMagnitude(f.estimatedImpact) > 0 ? "good" : "neutral",
        links_to_finding: f.ruleId,
      })),
    },
    method_notes: [
      { label: "Numbers", text: "Every figure comes from verified account data. The report does not invent chart values." },
      { label: "Benchmarks", text: validBenchmarkComparisons.length ? "Peer, historical, or industry comparisons are shown only where available." : "No benchmark section is rendered because no benchmark facts were available." },
      { label: "Confidence", text: "Confidence labels reflect data coverage, severity, and sample notes." },
    ],
  };
};

const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);

export const validateReportDocument = (doc) => {
  const errors = [];
  if (!isObj(doc)) errors.push("ReportDocument must be an object.");
  if (!isObj(doc?.masthead)) errors.push("masthead is required.");
  if (!Array.isArray(doc?.key_numbers) || doc.key_numbers.length < 3 || doc.key_numbers.length > 4) {
    errors.push("key_numbers must contain 3-4 cells.");
  }
  if (!isObj(doc?.executive_summary)) errors.push("executive_summary is required.");
  if (!Array.isArray(doc?.sections)) errors.push("sections must be an array.");
  if (!isObj(doc?.action_plan)) errors.push("action_plan is required.");
  if (!Array.isArray(doc?.method_notes)) errors.push("method_notes must be an array.");
  return { isValid: errors.length === 0, errors };
};

export const __test__ = {
  moneyMagnitude,
  escapePlain,
};
