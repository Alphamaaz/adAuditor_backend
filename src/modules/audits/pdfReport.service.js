import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";

const STORAGE_ROOT = process.env.PDF_STORAGE_DIR || "storage/pdf-reports";

const platformLabels = {
  META: "Meta",
  GOOGLE: "Google",
  TIKTOK: "TikTok",
};

const severityRank = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const ensureStorageDir = async () => {
  const absoluteDir = path.resolve(process.cwd(), STORAGE_ROOT);
  await fs.promises.mkdir(absoluteDir, { recursive: true });
  return absoluteDir;
};

const formatDate = (value) => {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
};

const formatPlatforms = (platforms = []) =>
  platforms.map((platform) => platformLabels[platform] || platform).join(", ");

const safeText = (value, fallback = "Not available") => {
  if (value === null || value === undefined || value === "") return fallback;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const addPageIfNeeded = (doc, neededHeight = 80) => {
  if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
};

const sectionTitle = (doc, title) => {
  addPageIfNeeded(doc, 70);
  doc.moveDown(0.9);
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#171717").text(title);
  doc.moveDown(0.4);
  doc.strokeColor("#e5ddd0").lineWidth(1).moveTo(50, doc.y).lineTo(562, doc.y).stroke();
  doc.moveDown(0.6);
};

const paragraph = (doc, text, options = {}) => {
  addPageIfNeeded(doc, 65);
  doc
    .font("Helvetica")
    .fontSize(options.size || 10)
    .fillColor(options.color || "#374151")
    .text(safeText(text), {
      lineGap: 3,
      ...options,
    });
  doc.moveDown(0.5);
};

const bullet = (doc, text) => {
  addPageIfNeeded(doc, 45);
  const startY = doc.y;
  doc.font("Helvetica").fontSize(10).fillColor("#374151").text("•", 58, startY);
  doc.text(safeText(text), 74, startY, {
    width: 480,
    lineGap: 3,
  });
  doc.moveDown(0.5);
};

const labeledValue = (doc, label, value) => {
  addPageIfNeeded(doc, 30);
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#6b7280").text(label, {
    continued: true,
  });
  doc.font("Helvetica").fontSize(9).fillColor("#374151").text(`  ${safeText(value)}`);
};

const drawSummaryBox = (doc, label, value, x, y, width) => {
  doc.roundedRect(x, y, width, 68, 6).strokeColor("#e5ddd0").stroke();
  doc.font("Helvetica").fontSize(8).fillColor("#6b7280").text(label, x + 12, y + 12, {
    width: width - 24,
  });
  doc.font("Helvetica-Bold").fontSize(20).fillColor("#171717").text(value, x + 12, y + 30, {
    width: width - 24,
  });
};

const normalizeAiOutput = (audit) => audit.aiReport?.output || {};

const getSortedFindings = (audit) =>
  [...(audit.ruleFindings || [])].sort(
    (left, right) =>
      (severityRank[right.severity] || 0) - (severityRank[left.severity] || 0)
  );

const writeHeader = (doc, audit) => {
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#171717").text("Ad Adviser Report");
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(10).fillColor("#6b7280").text("Client-ready advertising audit summary");
  doc.moveDown(1);

  labeledValue(doc, "Account", audit.adAccount?.name || "Audit");
  labeledValue(doc, "Platforms", formatPlatforms(audit.selectedPlatforms));
  labeledValue(doc, "Data source", audit.dataSource === "OAUTH" ? "OAuth/API connection" : "Manual upload");
  labeledValue(doc, "Completed", formatDate(audit.completedAt || audit.updatedAt));
};

const writeSummaryTiles = (doc, audit) => {
  const y = doc.y + 14;
  drawSummaryBox(doc, "Health score", `${audit.healthScore ?? 0}/100`, 50, y, 158);
  drawSummaryBox(doc, "Findings", String(audit.ruleFindings?.length || 0), 226, y, 158);
  drawSummaryBox(doc, "Readiness", audit.uploadReadiness?.mode || "UNKNOWN", 404, y, 158);
  doc.y = y + 82;
};

const writeAiSections = (doc, audit) => {
  const output = normalizeAiOutput(audit);

  if (output.executiveSummary?.length) {
    sectionTitle(doc, "Executive Summary");
    output.executiveSummary.forEach((item) => paragraph(doc, item));
  }

  if (output.confidenceNotes?.length) {
    sectionTitle(doc, "Confidence Notes");
    output.confidenceNotes.forEach((item) => bullet(doc, item));
  }

  if (output.topPriorities?.length) {
    sectionTitle(doc, "Top Priorities");
    output.topPriorities.forEach((priority, index) => {
      addPageIfNeeded(doc, 85);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#171717")
        .text(`${index + 1}. ${safeText(priority.title)}`);
      paragraph(
        doc,
        `${safeText(priority.severity, "")} ${safeText(priority.platform, "")} ${safeText(priority.ruleId, "")}`.trim(),
        { size: 8, color: "#6b7280" }
      );
      paragraph(doc, priority.estimatedImpact || priority.recommendedAction);
    });
  }

  if (output.quickWins?.length) {
    sectionTitle(doc, "Quick Wins");
    output.quickWins.forEach((quickWin) => {
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#171717").text(safeText(quickWin.title));
      (quickWin.fixSteps || []).forEach((step) => bullet(doc, step));
    });
  }

  if (output.clientReadyRecommendations?.length) {
    sectionTitle(doc, "Client-Ready Recommendations");
    output.clientReadyRecommendations.forEach((recommendation) => {
      addPageIfNeeded(doc, 95);
      doc
        .font("Helvetica-Bold")
        .fontSize(11)
        .fillColor("#171717")
        .text(safeText(recommendation.headline));
      paragraph(doc, recommendation.explanation);
      (recommendation.nextSteps || []).forEach((step) => bullet(doc, step));
    });
  }
};

const writeFindings = (doc, audit) => {
  const findings = getSortedFindings(audit);

  sectionTitle(doc, "Full Issue List");

  if (findings.length === 0) {
    paragraph(doc, "No rule findings were generated for this audit.");
    return;
  }

  findings.forEach((finding) => {
    addPageIfNeeded(doc, 110);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor("#171717")
      .text(`${finding.severity} - ${finding.title}`);
    paragraph(
      doc,
      `${safeText(finding.ruleId)} | ${safeText(finding.platform)} | ${safeText(finding.category)}`,
      { size: 8, color: "#6b7280" }
    );
    if (finding.detail) paragraph(doc, finding.detail);
    if (finding.estimatedImpact) paragraph(doc, `Impact: ${finding.estimatedImpact}`);
    if (finding.fixSteps?.length) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#374151").text("Fix steps");
      finding.fixSteps.slice(0, 5).forEach((step) => bullet(doc, step));
    }
  });
};

const writeFooter = (doc) => {
  const pageRange = doc.bufferedPageRange();

  for (let index = 0; index < pageRange.count; index += 1) {
    doc.switchToPage(index);
    doc
      .font("Helvetica")
      .fontSize(8)
      .fillColor("#9ca3af")
      .text(
        `Generated by Ad Adviser • Page ${index + 1} of ${pageRange.count}`,
        50,
        doc.page.height - 40,
        { align: "center", width: 512 }
      );
  }
};

export const generateAuditPdfFile = async ({ audit, version }) => {
  const storageDir = await ensureStorageDir();
  const fileName = `audit-${audit.id}-v${version}.pdf`;
  const absolutePath = path.join(storageDir, fileName);
  const relativePath = path.relative(process.cwd(), absolutePath);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 50,
      size: "A4",
      bufferPages: true,
      info: {
        Title: `Ad Adviser Report - ${audit.adAccount?.name || audit.id}`,
        Author: "Ad Adviser",
      },
    });
    const stream = fs.createWriteStream(absolutePath);

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);

    writeHeader(doc, audit);
    writeSummaryTiles(doc, audit);
    writeAiSections(doc, audit);
    writeFindings(doc, audit);
    writeFooter(doc);

    doc.end();
  });

  return {
    storagePath: relativePath,
    absolutePath,
  };
};

export const resolveStoredPdfPath = (storagePath) =>
  path.resolve(process.cwd(), storagePath);
