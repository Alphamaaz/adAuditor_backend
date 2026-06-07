import fs from "fs/promises";
import path from "path";
import ExcelJS from "exceljs";
import {
  getRequiredColumns,
  getReportLevel,
} from "./uploadRequirements.js";

const MAX_UPLOAD_DATE_RANGE_DAYS = Number(
  process.env.MAX_MANUAL_UPLOAD_RANGE_DAYS || 90
);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const FULL_REQUIREMENT_WARNINGS = {
  META: [
    "Full Meta audit will also need campaign, ad set, audience, and pixel event exports.",
  ],
  GOOGLE: [
    "Full Google audit will also need campaign, ad group, keyword, search terms, ad copy, audience, asset, and feed exports.",
  ],
  TIKTOK: [
    "Full TikTok audit will also need ad group, ad, audience, and pixel event exports.",
  ],
};

const headerKey = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/**
 * Strip currency codes/symbols from a numeric string.
 * Currency-agnostic: handles USD, PKR, EUR, GBP, INR, JPY, CAD, AUD, BRL,
 * MXN, NGN, ZAR, SGD, HKD, AED, SAR, plus generic $/€/£/¥/₹/₨ symbols and
 * thousand separators.
 */
const NUMBER_STRIP_PATTERN =
  /\b(USD|EUR|GBP|PKR|INR|JPY|CAD|AUD|BRL|MXN|NGN|ZAR|SGD|HKD|AED|SAR|CNY|KRW|TRY|RUB|CHF|NZD|SEK|NOK|DKK|PLN|CZK|HUF|THB|VND|IDR|PHP|MYR|TWD|ILS|EGP|KES|GHS|TZS|UGX|XAF|XOF)\b|[$€£¥₹₨,%\s]/gi;

const parseNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  const cleaned = String(value).replace(NUMBER_STRIP_PATTERN, "").trim();

  if (!cleaned || cleaned === "-") return null;

  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
};

/**
 * Try a list of header aliases against a row. Each alias may be:
 *   - a string  → exact match (case/whitespace-insensitive)
 *   - a RegExp  → tested against the original header text
 * Returns the first matching value or undefined.
 */
const getValue = (row, aliases) => {
  const entries = Object.entries(row);
  const normalizedRow = entries.reduce((acc, [key, value]) => {
    acc[headerKey(key)] = value;
    return acc;
  }, {});

  for (const alias of aliases) {
    if (alias instanceof RegExp) {
      const match = entries.find(([key]) => alias.test(String(key)));
      if (match && match[1] !== undefined) return match[1];
    } else {
      const value = normalizedRow[headerKey(alias)];
      if (value !== undefined) return value;
    }
  }

  return undefined;
};

/**
 * Detect the currency from a Meta-style "Amount spent (XXX)" header in any
 * row. Falls back to a "Currency" column if present, then null.
 */
const detectCurrency = (rows) => {
  if (rows.length === 0) return null;

  const sample = rows[0];
  const keys = Object.keys(sample);
  const amountKey = keys.find((key) => /^amount spent/i.test(key));

  if (amountKey) {
    const match = amountKey.match(/\(([^)]+)\)/);
    if (match) return match[1].trim().toUpperCase();
  }

  // Generic "Currency" column
  for (const row of rows.slice(0, 5)) {
    const ccy = getValue(row, ["Currency"]);
    if (ccy) return String(ccy).trim().toUpperCase();
  }

  return null;
};

const toUtcDate = (year, monthIndex, day) =>
  new Date(Date.UTC(year, monthIndex, day));

const isValidDate = (date) =>
  date instanceof Date && !Number.isNaN(date.getTime());

const parseMonthRange = (value) => {
  const match = String(value || "")
    .trim()
    .match(/^([A-Za-z]+)\s+(\d{4})$/);

  if (!match) return null;

  const monthStart = new Date(`${match[1]} 1, ${match[2]} UTC`);
  if (!isValidDate(monthStart)) return null;

  const start = toUtcDate(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth(),
    1
  );
  const end = toUtcDate(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    0
  );

  return { start, end };
};

const parseDate = (value) => {
  if (value instanceof Date && isValidDate(value)) return value;
  if (!value) return null;

  const parsed = new Date(String(value).trim());
  return isValidDate(parsed) ? parsed : null;
};

const extractDateRangeFromFilename = (originalName) => {
  const matches = [...originalName.matchAll(/\d{4}-\d{2}-\d{2}/g)].map(
    ([date]) => parseDate(date)
  );
  const validDates = matches.filter(Boolean);

  if (validDates.length < 2) return null;

  return {
    start: validDates[0],
    end: validDates[validDates.length - 1],
    source: "filename",
  };
};

const extractDateRangeFromRows = (rows) => {
  const dates = [];

  for (const row of rows) {
    const monthValue = getValue(row, ["Month"]);
    const monthRange = parseMonthRange(monthValue);

    if (monthRange) {
      dates.push(monthRange.start, monthRange.end);
      continue;
    }

    const startDate = parseDate(
      getValue(row, ["Reporting starts", "Start date", "Date start"])
    );
    const endDate = parseDate(
      getValue(row, ["Reporting ends", "End date", "Date end"])
    );
    const singleDate = parseDate(getValue(row, ["Date", "Day"]));

    if (startDate) dates.push(startDate);
    if (endDate) dates.push(endDate);
    if (!startDate && !endDate && singleDate) dates.push(singleDate);
  }

  if (dates.length === 0) return null;

  const timestamps = dates.map((date) => date.getTime());

  return {
    start: new Date(Math.min(...timestamps)),
    end: new Date(Math.max(...timestamps)),
    source: "rows",
  };
};

const getDateRangeDays = ({ start, end }) =>
  Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY) + 1;

const extractUploadDateRange = (rows, originalName) => {
  const rowRange = extractDateRangeFromRows(rows);
  const filenameRange = extractDateRangeFromFilename(originalName);
  const range = rowRange || filenameRange;

  if (!range) return null;

  return {
    start: range.start.toISOString().slice(0, 10),
    end: range.end.toISOString().slice(0, 10),
    days: getDateRangeDays(range),
    source: range.source,
    maxAllowedDays: MAX_UPLOAD_DATE_RANGE_DAYS,
  };
};

const parseCsvLine = (line) => {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === '"' && inQuotes && nextChar === '"') {
      value += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(value);
      value = "";
      continue;
    }

    value += char;
  }

  values.push(value);
  return values;
};

// Decode buffer handling UTF-16 LE/BE BOMs (Google Ads exports) and UTF-8 BOM.
const decodeBuffer = (buffer) => {
  // UTF-16 LE: BOM is FF FE
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le").replace(/^﻿/, "");
  }
  // UTF-16 BE: BOM is FE FF
  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length - 1; i += 2) {
      swapped[i] = buffer[i + 1];
      swapped[i + 1] = buffer[i];
    }
    return swapped.toString("utf16le").replace(/^﻿/, "");
  }
  // UTF-8 BOM: EF BB BF
  return buffer.toString("utf8").replace(/^﻿/, "");
};

const parseCsv = (buffer) => {
  const content = decodeBuffer(buffer);

  const allLines = content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);

  if (allLines.length === 0) return [];

  // Detect delimiter: Google Ads uses tabs, most others use commas.
  const sampleLine = allLines.find((l) => l.includes("\t") || l.includes(",")) ?? allLines[0];
  const useTab = (sampleLine.match(/\t/g) ?? []).length >= (sampleLine.match(/,/g) ?? []).length;
  const splitLine = useTab
    ? (line) => line.split("\t").map((v) => v.trim())
    : parseCsvLine;

  // Skip metadata title rows at the top (e.g. "Campaign report", "All time").
  // The real header is the first line that has more than 3 columns.
  let headerIndex = 0;
  for (let i = 0; i < Math.min(5, allLines.length); i++) {
    if (splitLine(allLines[i]).length > 3) {
      headerIndex = i;
      break;
    }
  }

  const lines = allLines.slice(headerIndex);
  if (lines.length === 0) return [];

  const headers = splitLine(lines[0]);

  return lines
    .slice(1)
    .filter((line) => {
      // Drop Google Ads "Total: Campaigns / Account / Video / …" summary rows.
      const firstCell = splitLine(line)[0] ?? "";
      return !firstCell.trim().startsWith("Total:");
    })
    .map((line) => {
      const values = splitLine(line);
      return headers.reduce((row, header, index) => {
        row[header] = values[index] ?? "";
        return row;
      }, {});
    });
};

const parseRows = async (filePath, originalName) => {
  const extension = path.extname(originalName).toLowerCase();
  const buffer = await fs.readFile(filePath);

  if (extension === ".csv") return parseCsv(buffer);

  if (extension === ".json") {
    const json = JSON.parse(buffer.toString("utf8"));
    return Array.isArray(json) ? json : json.rows || [];
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];

  if (!sheet) return [];

  const headers = [];
  sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber - 1] = cell.text;
  });

  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const parsedRow = {};
    headers.forEach((header, index) => {
      parsedRow[header] = row.getCell(index + 1).text;
    });
    rows.push(parsedRow);
  });

  return rows;
};

const sum = (rows, selector) =>
  rows.reduce((total, row) => total + (parseNumber(selector(row)) || 0), 0);

// ── Meta normalizers (level-aware) ─────────────────────────────────────────

const AMOUNT_SPENT_ALIASES = [/^amount spent/i, "Amount spent", "Spend"];
const COST_PER_PURCHASE_ALIASES = [
  /^cost per purchase/i,
  /^cost per result/i,
  "Cost per results",
];
// Objective-spanning result columns. "Results" is Meta's own pre-computed,
// objective-aware count (purchases, leads, or messaging conversations); the
// rest are fallbacks for exports that use an objective-specific column name.
const META_RESULT_ALIASES = [
  "Results",
  "Purchases",
  "Leads",
  "Total messaging contacts",
  "Messaging conversations started",
];

const normalizeMetaCampaign = (rows) =>
  rows.map((row) => ({
    level: "campaign",
    name: getValue(row, ["Campaign name", "Campaign"]),
    status: getValue(row, ["Campaign delivery", "Status", "Delivery"]),
    objective: getValue(row, ["Objective", "Buying type"]),
    budget: parseNumber(
      getValue(row, ["Campaign budget", "Daily budget", "Lifetime budget"])
    ),
    spend: parseNumber(getValue(row, AMOUNT_SPENT_ALIASES)),
    impressions: parseNumber(getValue(row, ["Impressions"])),
    reach: parseNumber(getValue(row, ["Reach"])),
    clicks: parseNumber(getValue(row, ["Link clicks", "Clicks (all)", "Clicks"])),
    results: parseNumber(getValue(row, META_RESULT_ALIASES)),
    cpa: parseNumber(getValue(row, COST_PER_PURCHASE_ALIASES)),
    roas: parseNumber(
      getValue(row, ["Purchase ROAS", "Website purchase ROAS"])
    ),
    frequency: parseNumber(getValue(row, ["Frequency"])),
    dateStart: getValue(row, ["Reporting starts"]),
    dateEnd: getValue(row, ["Reporting ends"]),
  }));

const normalizeMetaAdSet = (rows) =>
  rows.map((row) => ({
    level: "adset",
    name: getValue(row, ["Ad set name"]),
    campaignName: getValue(row, ["Campaign name"]),
    status: getValue(row, ["Ad set delivery", "Delivery"]),
    learningPhase: getValue(row, ["Learning phase", "Delivery status"]),
    budget: parseNumber(
      getValue(row, ["Ad set budget", "Daily budget", "Lifetime budget"])
    ),
    spend: parseNumber(getValue(row, AMOUNT_SPENT_ALIASES)),
    impressions: parseNumber(getValue(row, ["Impressions"])),
    reach: parseNumber(getValue(row, ["Reach"])),
    frequency: parseNumber(getValue(row, ["Frequency"])),
    clicks: parseNumber(getValue(row, ["Link clicks", "Clicks (all)", "Clicks"])),
    results: parseNumber(getValue(row, META_RESULT_ALIASES)),
    cpa: parseNumber(getValue(row, COST_PER_PURCHASE_ALIASES)),
    roas: parseNumber(getValue(row, ["Purchase ROAS"])),
    audienceSize: getValue(row, ["Audience size", "Estimated audience size"]),
    dateStart: getValue(row, ["Reporting starts"]),
    dateEnd: getValue(row, ["Reporting ends"]),
  }));

const normalizeMetaAd = (rows) =>
  rows.map((row) => ({
    level: "ad",
    name: getValue(row, ["Ad name"]),
    adSetName: getValue(row, ["Ad set name"]),
    campaignName: getValue(row, ["Campaign name"]),
    status: getValue(row, ["Ad delivery", "Delivery"]),
    spend: parseNumber(getValue(row, AMOUNT_SPENT_ALIASES)),
    impressions: parseNumber(getValue(row, ["Impressions"])),
    reach: parseNumber(getValue(row, ["Reach"])),
    frequency: parseNumber(getValue(row, ["Frequency"])),
    clicks: parseNumber(getValue(row, ["Link clicks", "Clicks (all)", "Clicks"])),
    ctr: parseNumber(getValue(row, ["CTR (link click-through rate)", "CTR (all)", "CTR"])),
    results: parseNumber(getValue(row, META_RESULT_ALIASES)),
    cpa: parseNumber(getValue(row, COST_PER_PURCHASE_ALIASES)),
    qualityRanking: getValue(row, ["Quality ranking"]),
    engagementRanking: getValue(row, ["Engagement rate ranking"]),
    conversionRanking: getValue(row, ["Conversion rate ranking"]),
    dateStart: getValue(row, ["Reporting starts"]),
    dateEnd: getValue(row, ["Reporting ends"]),
  }));

const normalizeMetaAudience = (rows) =>
  rows.map((row) => ({
    level: "audience",
    name: getValue(row, ["Audience", "Audience name"]),
    type: getValue(row, ["Audience type", "Type"]),
    size: parseNumber(getValue(row, ["Audience size", "Size"])),
    spend: parseNumber(getValue(row, AMOUNT_SPENT_ALIASES)),
  }));

const normalizeMetaPixel = (rows) =>
  rows.map((row) => ({
    level: "pixel_event",
    event: getValue(row, ["Event", "Event name"]),
    count: parseNumber(getValue(row, ["Count", "Event count", "Volume"])),
    source: getValue(row, ["Source", "Event source"]),
  }));

// ── Google normalizers ─────────────────────────────────────────────────────

const normalizeGoogleCampaign = (rows) =>
  rows.map((row) => ({
    level: "campaign",
    name: getValue(row, ["Campaign", "Campaign name"]),
    type: getValue(row, ["Campaign type", "Advertising channel type"]),
    status: getValue(row, ["Campaign status", "Status"]),
    bidStrategy: getValue(row, ["Bid strategy", "Bid strategy type"]),
    budget: parseNumber(getValue(row, ["Budget", "Daily budget"])),
    spend: parseNumber(getValue(row, ["Cost"])),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    convValue: parseNumber(
      getValue(row, ["Conv. value", "Conversion value"])
    ),
    ctr: parseNumber(getValue(row, ["CTR"])),
    cpa: parseNumber(getValue(row, ["Cost / conv.", "Cost per conv.", "CPA"])),
  }));

const normalizeGoogleAdGroup = (rows) =>
  rows.map((row) => ({
    level: "ad_group",
    name: getValue(row, ["Ad group"]),
    campaignName: getValue(row, ["Campaign"]),
    status: getValue(row, ["Ad group status", "Status"]),
    spend: parseNumber(getValue(row, ["Cost"])),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    convValue: parseNumber(getValue(row, ["Conv. value"])),
    ctr: parseNumber(getValue(row, ["CTR"])),
    cpa: parseNumber(getValue(row, ["Cost / conv."])),
  }));

const normalizeGoogleKeyword = (rows) =>
  rows.map((row) => ({
    level: "keyword",
    keyword: getValue(row, ["Keyword", "Search keyword"]),
    matchType: getValue(row, ["Match type", "Keyword match type"]),
    adGroupName: getValue(row, ["Ad group"]),
    campaignName: getValue(row, ["Campaign"]),
    status: getValue(row, ["Keyword status", "Status"]),
    qualityScore: parseNumber(getValue(row, ["Quality Score", "Qual. score"])),
    spend: parseNumber(getValue(row, ["Cost"])),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    convValue: parseNumber(getValue(row, ["Conv. value"])),
    ctr: parseNumber(getValue(row, ["CTR"])),
  }));

const normalizeGoogleSearchTerm = (rows) =>
  rows.map((row) => ({
    level: "search_term",
    searchTerm: getValue(row, ["Search term"]),
    matchType: getValue(row, ["Match type", "Search keyword match type"]),
    addedExcluded: getValue(row, ["Added/Excluded", "Status"]),
    keyword: getValue(row, ["Keyword", "Search keyword"]),
    adGroupName: getValue(row, ["Ad group"]),
    campaignName: getValue(row, ["Campaign"]),
    spend: parseNumber(getValue(row, ["Cost"])),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
  }));

const normalizeGoogleAdCopy = (rows) =>
  rows.map((row) => ({
    level: "ad_copy",
    headline: getValue(row, ["Ad", "Headline"]),
    description: getValue(row, ["Description"]),
    finalUrl: getValue(row, ["Final URL"]),
    status: getValue(row, ["Ad status", "Status"]),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    ctr: parseNumber(getValue(row, ["CTR"])),
  }));

const normalizeGoogleAudience = (rows) =>
  rows.map((row) => ({
    level: "audience",
    name: getValue(row, ["Audience", "Audience name"]),
    spend: parseNumber(getValue(row, ["Cost"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    bidAdjustment: getValue(row, ["Bid adj.", "Bid adjustment"]),
  }));

const normalizeGoogleAsset = (rows) =>
  rows.map((row) => ({
    level: "asset",
    asset: getValue(row, ["Asset"]),
    type: getValue(row, ["Asset type", "Type"]),
    performance: getValue(row, ["Performance", "Performance label"]),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
  }));

const normalizeGoogleFeed = (rows) =>
  rows.map((row) => ({
    level: "feed",
    item: getValue(row, ["Item", "Item title"]),
    status: getValue(row, ["Status", "Item status"]),
    issues: getValue(row, ["Issues", "Disapproval reason"]),
  }));

const normalizeGoogleTimeSeries = (rows) =>
  rows.map((row) => ({
    level: "time_series",
    period: getValue(row, ["Month", "Date", "Day"]),
    spend: parseNumber(getValue(row, ["Cost"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    impressions: parseNumber(getValue(row, ["Impr.", "Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
  }));

// ── TikTok normalizers ─────────────────────────────────────────────────────

const normalizeTikTokCampaign = (rows) =>
  rows.map((row) => ({
    level: "campaign",
    name: getValue(row, ["Campaign name"]),
    status: getValue(row, ["Primary status", "Status"]),
    objective: getValue(row, ["Objective"]),
    budget: parseNumber(getValue(row, ["Campaign Budget", "Budget"])),
    spend: parseNumber(getValue(row, ["Cost", "Spend"])),
    impressions: parseNumber(getValue(row, ["Impressions"])),
    clicks: parseNumber(
      getValue(row, ["Clicks (destination)", "Clicks"])
    ),
    cpc: parseNumber(getValue(row, ["CPC (destination)", "CPC"])),
    cpm: parseNumber(getValue(row, ["CPM"])),
    ctr: parseNumber(getValue(row, ["CTR (destination)", "CTR"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    cpa: parseNumber(
      getValue(row, ["Cost per conversion", "Cost per result"])
    ),
    currency: getValue(row, ["Currency"]),
  }));

const normalizeTikTokAdGroup = (rows) =>
  rows.map((row) => ({
    level: "ad_group",
    name: getValue(row, ["Ad group name"]),
    campaignName: getValue(row, ["Campaign name"]),
    status: getValue(row, ["Status"]),
    budget: parseNumber(getValue(row, ["Budget", "Ad group budget"])),
    spend: parseNumber(getValue(row, ["Cost", "Spend"])),
    impressions: parseNumber(getValue(row, ["Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    cpa: parseNumber(getValue(row, ["Cost per conversion"])),
  }));

const normalizeTikTokAd = (rows) =>
  rows.map((row) => ({
    level: "ad",
    name: getValue(row, ["Ad name"]),
    adGroupName: getValue(row, ["Ad group name"]),
    campaignName: getValue(row, ["Campaign name"]),
    status: getValue(row, ["Status"]),
    spend: parseNumber(getValue(row, ["Cost", "Spend"])),
    impressions: parseNumber(getValue(row, ["Impressions"])),
    clicks: parseNumber(getValue(row, ["Clicks"])),
    ctr: parseNumber(getValue(row, ["CTR"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
    cpa: parseNumber(getValue(row, ["Cost per conversion"])),
  }));

const normalizeTikTokAudience = (rows) =>
  rows.map((row) => ({
    level: "audience",
    name: getValue(row, ["Audience"]),
    spend: parseNumber(getValue(row, ["Cost", "Spend"])),
    conversions: parseNumber(getValue(row, ["Conversions"])),
  }));

const normalizeTikTokPixel = (rows) =>
  rows.map((row) => ({
    level: "pixel_event",
    event: getValue(row, ["Event", "Event name"]),
    count: parseNumber(getValue(row, ["Count", "Event count"])),
  }));

/**
 * Dispatch table: (platform, reportType) → normalizer.
 * Falls back to a generic "first-level-found" record so unknown report types
 * still parse without losing data.
 */
const NORMALIZERS = {
  META: {
    CAMPAIGN_PERFORMANCE_30D: normalizeMetaCampaign,
    CAMPAIGN_PERFORMANCE_90D: normalizeMetaCampaign,
    AD_SET_PERFORMANCE_30D: normalizeMetaAdSet,
    AD_SET_PERFORMANCE_90D: normalizeMetaAdSet,
    AD_PERFORMANCE_30D: normalizeMetaAd,
    AD_PERFORMANCE_90D: normalizeMetaAd,
    AD_PERFORMANCE: normalizeMetaAd,
    AUDIENCE_DETAILS: normalizeMetaAudience,
    PIXEL_EVENTS_30D: normalizeMetaPixel,
  },
  GOOGLE: {
    TIME_SERIES: normalizeGoogleTimeSeries,
    CAMPAIGN_PERFORMANCE_30D: normalizeGoogleCampaign,
    CAMPAIGN_PERFORMANCE_90D: normalizeGoogleCampaign,
    AD_GROUP_REPORT_30D: normalizeGoogleAdGroup,
    KEYWORD_REPORT_30D: normalizeGoogleKeyword,
    SEARCH_TERMS_30D: normalizeGoogleSearchTerm,
    AD_COPY_REPORT_30D: normalizeGoogleAdCopy,
    AUDIENCE_BIDDING_30D: normalizeGoogleAudience,
    ASSET_REPORT_30D: normalizeGoogleAsset,
    SHOPPING_PMAX_FEED: normalizeGoogleFeed,
  },
  TIKTOK: {
    CAMPAIGN_PERFORMANCE_30D: normalizeTikTokCampaign,
    CAMPAIGN_PERFORMANCE_90D: normalizeTikTokCampaign,
    CAMPAIGN_PERFORMANCE: normalizeTikTokCampaign,
    AD_GROUP_REPORT_30D: normalizeTikTokAdGroup,
    AD_PERFORMANCE_30D: normalizeTikTokAd,
    AUDIENCE_REPORT: normalizeTikTokAudience,
    PIXEL_EVENTS_30D: normalizeTikTokPixel,
  },
};

const normalizeRows = (platform, reportType, rows) => {
  const normalizer = NORMALIZERS[platform]?.[reportType];
  if (normalizer) return normalizer(rows);
  // Unknown report type: pass-through with level=unknown so we don't silently drop.
  return rows.map((row) => ({ level: "unknown", raw: row }));
};

const getHeaders = (rows) => {
  const headers = new Set();
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => headers.add(key));
  });
  return [...headers];
};

const matchesRequired = (header, spec) => {
  if (spec instanceof RegExp) return spec.test(header);
  return headerKey(header) === headerKey(spec);
};

const findMissingRequiredColumns = (headers, requiredColumns) =>
  requiredColumns.filter(
    (spec) => !headers.some((header) => matchesRequired(header, spec))
  );

const describeRequiredColumn = (spec) =>
  spec instanceof RegExp ? spec.source : spec;

const validateRows = ({ platform, reportType, rows, originalName }) => {
  const headers = getHeaders(rows);
  const requiredColumns = getRequiredColumns(platform, reportType);
  const missingColumns = findMissingRequiredColumns(
    headers,
    requiredColumns
  ).map(describeRequiredColumn);
  const warnings = [...(FULL_REQUIREMENT_WARNINGS[platform] || [])];
  const dateRange = extractUploadDateRange(rows, originalName);
  const currency = detectCurrency(rows);

  if (rows.length === 0) {
    warnings.push("The file has no data rows.");
  }

  if (!dateRange) {
    warnings.push(
      "Date range could not be detected. Include date columns or a date range in the filename."
    );
  }

  const dateRangeTooLong =
    dateRange && dateRange.days > MAX_UPLOAD_DATE_RANGE_DAYS;

  if (dateRangeTooLong) {
    warnings.push(
      `Manual uploads cannot contain more than ${MAX_UPLOAD_DATE_RANGE_DAYS} days of data. This file contains ${dateRange.days} days.`
    );
  }

  return {
    isValid:
      missingColumns.length === 0 && rows.length > 0 && !dateRangeTooLong,
    rowCount: rows.length,
    columns: headers,
    requiredColumns: requiredColumns.map(describeRequiredColumn),
    missingColumns,
    dateRange,
    currency,
    warnings,
  };
};

const summarizeRecords = (platform, records, currency) => ({
  platform,
  rowCount: records.length,
  spend: sum(records, (row) => row.spend),
  impressions: sum(records, (row) => row.impressions),
  clicks: sum(records, (row) => row.clicks),
  conversions: sum(records, (row) => row.conversions ?? row.results),
  reach: sum(records, (row) => row.reach),
  currency,
});

// ── Dimension/time-series breakdown detection (CSV) ─────────────────────────
// A breakdown export (e.g. Meta "Age" or "Placement") carries a demographic /
// placement / device / region column alongside metrics. These columns never
// appear in normal entity exports, so detecting them is safe — when absent,
// byDimension stays empty and existing uploads are unaffected.

const DIMENSION_ALIASES = {
  age: ["Age", "Age range", "Age Range"],
  gender: ["Gender"],
  placement: ["Placement", "Publisher platform", "Publisher Platform", "Platform position", "Platform Position"],
  device: ["Device", "Device platform", "Device Platform", "Impression device"],
  region: ["Region", "Country", "Geo", "DMA region", "DMA Region"],
};

const ENTITY_NAME_ALIASES = [
  "Campaign name", "Campaign", "Ad name", "Ad set name", "Ad group", "Ad Group",
  "Keyword", "Search term", "Search Term",
];

const DAY_ALIASES = ["Day", "Date"];

const metricValue = (row, kind) => {
  if (kind === "spend") return parseNumber(getValue(row, [...AMOUNT_SPENT_ALIASES, "Cost", "Spend"]));
  if (kind === "impressions") return parseNumber(getValue(row, ["Impressions", "Impr.", "Impr"]));
  if (kind === "clicks") return parseNumber(getValue(row, ["Link clicks", "Clicks (all)", "Clicks"]));
  if (kind === "conversions")
    return parseNumber(
      getValue(row, ["Conversions", "Results", "Purchases", "Total messaging contacts"])
    );
  return null;
};

const hasColumn = (headers, aliases) =>
  aliases.some((a) => headers.some((h) => headerKey(h) === headerKey(a)));

/**
 * Extract byDimension + byDay from parsed rows when breakdown/time-series
 * columns are present. Aggregates by segment so multi-row inputs collapse
 * correctly. Returns { byDimension: {dim:[...]}, byDay: [...] } — both may be empty.
 */
export const extractBreakdowns = (rows) => {
  const byDimension = {};
  const byDay = [];
  if (!Array.isArray(rows) || rows.length === 0) return { byDimension, byDay };

  const headers = getHeaders(rows);
  const hasEntity = hasColumn(headers, ENTITY_NAME_ALIASES);

  // Dimensions — safe whenever a recognized breakdown column exists.
  for (const [dimension, aliases] of Object.entries(DIMENSION_ALIASES)) {
    if (!hasColumn(headers, aliases)) continue;
    const bySegment = new Map();
    for (const row of rows) {
      const segRaw = getValue(row, aliases);
      const segment = segRaw != null && String(segRaw).trim() ? String(segRaw).trim() : "unknown";
      const acc =
        bySegment.get(segment) ||
        { dimension, segment, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      acc.spend += metricValue(row, "spend") || 0;
      acc.impressions += metricValue(row, "impressions") || 0;
      acc.clicks += metricValue(row, "clicks") || 0;
      acc.conversions += metricValue(row, "conversions") || 0;
      bySegment.set(segment, acc);
    }
    const seg = [...bySegment.values()].map((s) => ({ ...s, results: s.conversions }));
    if (seg.length > 0) byDimension[dimension] = seg;
  }

  // Daily series — ONLY for account-level daily exports (a Day/Date column and
  // NO entity-name column). Guards against treating a campaign report's date
  // columns as a time series.
  if (!hasEntity && hasColumn(headers, DAY_ALIASES)) {
    const byDate = new Map();
    for (const row of rows) {
      const dRaw = getValue(row, DAY_ALIASES);
      const date = dRaw != null ? String(dRaw).trim() : "";
      if (!date) continue;
      const acc =
        byDate.get(date) ||
        { date, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      acc.spend += metricValue(row, "spend") || 0;
      acc.impressions += metricValue(row, "impressions") || 0;
      acc.clicks += metricValue(row, "clicks") || 0;
      acc.conversions += metricValue(row, "conversions") || 0;
      byDate.set(date, acc);
    }
    byDay.push(...[...byDate.values()].map((d) => ({ ...d, results: d.conversions })));
  }

  return { byDimension, byDay };
};

export const parseAndNormalizeUpload = async ({
  filePath,
  originalName,
  platform,
  reportType,
}) => {
  const rows = await parseRows(filePath, originalName);
  const validation = validateRows({
    platform,
    reportType,
    rows,
    originalName,
  });
  const records = normalizeRows(platform, reportType, rows);
  const summary = summarizeRecords(platform, records, validation.currency);
  const level = getReportLevel(platform, reportType);
  const breakdowns = extractBreakdowns(rows);

  return {
    validation,
    records,
    summary,
    level,
    breakdowns,
  };
};

/**
 * Empty platform shape — `byLevel` keeps records bucketed by entity level
 * so the rule engine can target campaigns/keywords/etc directly. `records`
 * is kept for backward compat with anything still iterating flat.
 */
const emptyPlatformShape = () => ({
  files: [],
  records: [],
  byLevel: {},
  // Forward-compatible structure for dimension breakdowns + daily series.
  // Populated when breakdown/time-series reports are available (CSV or OAuth);
  // safe empty defaults otherwise so existing rules are unaffected.
  byDimension: {},
  byDay: {},
  currency: null,
});

const emptyPlatformSummary = () => ({
  uploadedFiles: 0,
  rowCount: 0,
  spend: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  reach: 0,
  currency: null,
});

export const mergeNormalizedDataset = ({
  existingDataset,
  platform,
  reportType,
  uploadedFileId,
  records,
  uploadSummary,
  level,
  breakdowns,
}) => {
  const existingData = existingDataset?.data || { platforms: {} };
  const existingSummary = existingDataset?.summary || {
    platforms: {},
    totals: {},
  };
  const platformData = {
    ...emptyPlatformShape(),
    ...(existingData.platforms?.[platform] || {}),
  };
  const platformSummary = {
    ...emptyPlatformSummary(),
    ...(existingSummary.platforms?.[platform] || {}),
  };

  // Bucket records by their reported level (campaign/adset/ad/keyword/etc).
  // Falls back to the report-level mapping if individual records don't carry level.
  const bucketLevel = level || "unknown";
  const nextByLevel = { ...(platformData.byLevel || {}) };
  records.forEach((record) => {
    const recordLevel = record.level || bucketLevel;
    if (!nextByLevel[recordLevel]) nextByLevel[recordLevel] = [];
    nextByLevel[recordLevel].push(record);
  });

  // Merge any detected dimension breakdowns + daily series (CSV). Each new
  // dimension replaces the prior bucket for that dimension (latest upload wins);
  // byDay is appended. Both default empty so non-breakdown uploads are no-ops.
  const nextByDimension = { ...(platformData.byDimension || {}) };
  for (const [dim, seg] of Object.entries(breakdowns?.byDimension || {})) {
    if (Array.isArray(seg) && seg.length > 0) nextByDimension[dim] = seg;
  }
  const nextByDay = [
    ...(Array.isArray(platformData.byDay) ? platformData.byDay : []),
    ...(Array.isArray(breakdowns?.byDay) ? breakdowns.byDay : []),
  ];

  const nextPlatformSummary = {
    ...platformSummary,
    uploadedFiles: platformSummary.uploadedFiles + 1,
    rowCount: platformSummary.rowCount + uploadSummary.rowCount,
    spend: platformSummary.spend + uploadSummary.spend,
    impressions: platformSummary.impressions + uploadSummary.impressions,
    clicks: platformSummary.clicks + uploadSummary.clicks,
    conversions: platformSummary.conversions + uploadSummary.conversions,
    reach: platformSummary.reach + uploadSummary.reach,
    currency: platformSummary.currency || uploadSummary.currency || null,
  };

  const nextData = {
    ...existingData,
    platforms: {
      ...(existingData.platforms || {}),
      [platform]: {
        ...platformData,
        files: [
          ...(platformData.files || []),
          {
            uploadedFileId,
            reportType,
            level: bucketLevel,
            rowCount: records.length,
          },
        ],
        records: [...(platformData.records || []), ...records],
        byLevel: nextByLevel,
        byDimension: nextByDimension,
        byDay: nextByDay,
        currency: platformData.currency || uploadSummary.currency || null,
      },
    },
  };

  const nextPlatformSummaries = {
    ...(existingSummary.platforms || {}),
    [platform]: nextPlatformSummary,
  };

  const totals = Object.values(nextPlatformSummaries).reduce(
    (acc, s) => ({
      uploadedFiles: acc.uploadedFiles + s.uploadedFiles,
      rowCount: acc.rowCount + s.rowCount,
      spend: acc.spend + s.spend,
      impressions: acc.impressions + s.impressions,
      clicks: acc.clicks + s.clicks,
      conversions: acc.conversions + s.conversions,
      reach: acc.reach + s.reach,
    }),
    {
      uploadedFiles: 0,
      rowCount: 0,
      spend: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      reach: 0,
    }
  );

  return {
    data: nextData,
    summary: {
      platforms: nextPlatformSummaries,
      totals,
    },
  };
};
