import fs from "node:fs";
import { prisma } from "../../lib/prisma.js";
import { getOrganizationId } from "../../utils/requestContext.js";
import { badRequest, notFound, paymentRequired } from "../../utils/appError.js";
import {
  getAiNarrativeMode,
  resolveEffectivePlan,
} from "../plans/plan.resolver.js";
import {
  serializeAdAccount,
  serializeAudit,
  serializeIntakeResponse,
  serializeNormalizedDataset,
  serializePdfReport,
  serializeUploadedFile,
} from "./audit.presenter.js";
import {
  mergeNormalizedDataset,
  parseAndNormalizeUpload,
} from "./manualUpload.service.js";
import { calculateUploadReadiness } from "./uploadReadiness.service.js";
import { resolveStoredPdfPath } from "./pdfReport.service.js";
import {
  enqueueGenerateAiReport,
  enqueueGeneratePdfReport,
  enqueueRunAudit,
} from "../../queues/auditQueue.js";
import { getDriver } from "../../queues/jobQueue.js";
import {
  fetchAuditComparison,
  fetchAuditTrend,
} from "./auditHistory.service.js";
import { isDeepAuditEnabled } from "./agent/config.js";
import { runDeepAuditForAudit } from "./agent/deepAudit.service.js";

const formatPlatformLabel = (platform) =>
  ({
    META: "Meta",
    GOOGLE: "Google",
    TIKTOK: "TikTok",
  })[platform] || platform;

const buildAdAccountName = (accountName, platform, totalPlatforms) =>
  totalPlatforms > 1
    ? `${accountName} - ${formatPlatformLabel(platform)}`
    : accountName;

/**
 * Overlay the lightweight new-audit context onto the org's existing business
 * profile answers. Context fields win when present; everything else is
 * preserved. Returns null when there is neither existing data nor context,
 * so the snapshot stays undefined rather than an empty object.
 */
const buildSnapshotFromContext = (existingAnswers, context) => {
  const base = existingAnswers && typeof existingAnswers === "object" ? existingAnswers : {};
  const ctx = context || {};

  const overlay = {};
  for (const key of [
    "businessType",
    "monthlyBudget",
    "mainGoal",
    "auditFocus",
    "auditFocusOther",
    "targetCpa",
    "targetRoas",
    "brandTerms",
  ]) {
    if (ctx[key] !== undefined && ctx[key] !== null && ctx[key] !== "") {
      overlay[key] = ctx[key];
    }
  }

  const hasExisting = Object.keys(base).length > 0;
  const hasOverlay = Object.keys(overlay).length > 0;
  if (!hasExisting && !hasOverlay) return null;

  return {
    ...base,
    sectionA: {
      ...(base.sectionA || {}),
      ...overlay,
    },
  };
};

export const createAuditSetup = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { accountName, selectedPlatforms, dataSource, context } = req.body;
  const uniquePlatforms = [...new Set(selectedPlatforms)];

  const existingAnswers =
    req.user.memberships?.[0]?.organization?.businessProfile?.answers || null;
  const snapshot = buildSnapshotFromContext(existingAnswers, context);

  const result = await prisma.$transaction(async (tx) => {
    const adAccounts = [];

    for (const platform of uniquePlatforms) {
      const adAccount = await tx.adAccount.create({
        data: {
          organizationId,
          platform,
          name: buildAdAccountName(accountName, platform, uniquePlatforms.length),
        },
      });

      adAccounts.push(adAccount);
    }

    const audit = await tx.audit.create({
      data: {
        organizationId,
        createdById: req.user.id,
        adAccountId: adAccounts[0]?.id,
        selectedPlatforms: uniquePlatforms,
        dataSource,
        status: "INTAKE_IN_PROGRESS",
        businessProfileSnapshot: snapshot || undefined,
      },
      include: {
        adAccount: true,
      },
    });

    // Persist the context onto the org's business profile so future audits
    // prefill and hasBusinessProfile flips true (removes onboarding friction).
    // Best-effort + only when we actually have context to save.
    if (snapshot) {
      await tx.businessProfile.upsert({
        where: { organizationId },
        create: { organizationId, userId: req.user.id, answers: snapshot },
        update: { answers: snapshot },
      });
    }

    await tx.auditEvent.create({
      data: {
        auditId: audit.id,
        type: "AUDIT_SETUP_CREATED",
        message: "Audit setup created.",
        metadata: {
          selectedPlatforms: uniquePlatforms,
          dataSource,
          adAccountIds: adAccounts.map((account) => account.id),
        },
      },
    });

    return {
      audit,
      adAccounts,
    };
  });

  res.status(201).json({
    status: "success",
    data: {
      audit: serializeAudit(result.audit),
      adAccounts: result.adAccounts.map(serializeAdAccount),
    },
  });
};

export const submitPlatformIntake = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const audit = await prisma.audit.findFirst({
    where: {
      id: req.params.auditId,
      organizationId,
    },
  });

  if (!audit) {
    throw notFound("Audit not found");
  }

  const responses = req.body.responses;
  const missingPlatforms = audit.selectedPlatforms.filter(
    (platform) => !responses[platform]
  );

  if (missingPlatforms.length > 0) {
    throw badRequest("Missing intake answers for selected platforms.", {
      missingPlatforms,
    });
  }

  const nextStatus =
    audit.dataSource === "MANUAL_UPLOAD" ? "WAITING_FOR_DATA" : "DRAFT";

  const result = await prisma.$transaction(async (tx) => {
    const intakeResponses = [];

    for (const platform of audit.selectedPlatforms) {
      const intakeResponse = await tx.intakeResponse.upsert({
        where: {
          auditId_section: {
            auditId: audit.id,
            section: `PLATFORM_${platform}`,
          },
        },
        create: {
          auditId: audit.id,
          section: `PLATFORM_${platform}`,
          answers: responses[platform],
        },
        update: {
          answers: responses[platform],
        },
      });

      intakeResponses.push(intakeResponse);
    }

    const updatedAudit = await tx.audit.update({
      where: {
        id: audit.id,
      },
      data: {
        status: nextStatus,
      },
      include: {
        adAccount: true,
        intakeResponses: true,
      },
    });

    await tx.auditEvent.create({
      data: {
        auditId: audit.id,
        type: "PLATFORM_INTAKE_COMPLETED",
        message: "Platform-specific intake completed.",
        metadata: {
          selectedPlatforms: audit.selectedPlatforms,
          nextStatus,
        },
      },
    });

    return {
      audit: updatedAudit,
      intakeResponses,
    };
  });

  res.json({
    status: "success",
    data: {
      audit: serializeAudit(result.audit),
      intakeResponses: result.intakeResponses.map(serializeIntakeResponse),
    },
  });
};

export const listAudits = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const audits = await prisma.audit.findMany({
    where: {
      organizationId,
    },
    include: {
      adAccount: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json({
    status: "success",
    data: audits.map(serializeAudit),
  });
};

export const getAudit = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const audit = await prisma.audit.findFirst({
    where: {
      id: req.params.auditId,
      organizationId,
    },
    include: {
      adAccount: true,
      intakeResponses: true,
      uploadedFiles: {
        orderBy: {
          createdAt: "desc",
        },
      },
      normalizedDataset: true,
      ruleFindings: {
        orderBy: {
          createdAt: "desc",
        },
      },
      aiReport: true,
      pdfReports: {
        orderBy: {
          createdAt: "desc",
        },
      },
    },
  });

  if (!audit) {
    throw notFound("Audit not found");
  }

  res.json({
    status: "success",
    data: serializeAudit(audit),
  });
};

export const generatePdfReport = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const audit = await prisma.audit.findFirst({
    where: { id: req.params.auditId, organizationId },
    select: { id: true, status: true },
  });

  if (!audit) {
    throw notFound("Audit not found");
  }

  if (audit.status !== "COMPLETED") {
    throw badRequest("Run the audit before generating a PDF report.");
  }

  await prisma.auditEvent.create({
    data: {
      auditId: audit.id,
      type: "PDF_REPORT_QUEUED",
      message: "PDF report generation queued.",
      metadata: { driver: getDriver() },
    },
  });

  const job = await enqueueGeneratePdfReport({ auditId: audit.id });

  res.status(202).json({
    status: "queued",
    data: {
      auditId: audit.id,
      jobId: job.id,
      driver: job.driver,
      pollUrl: `/api/audits/${audit.id}`,
    },
  });
};

export const downloadPdfReport = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const pdfReport = await prisma.pdfReport.findFirst({
    where: {
      id: req.params.pdfReportId,
      auditId: req.params.auditId,
      audit: {
        organizationId,
      },
    },
    include: {
      audit: {
        include: {
          adAccount: true,
        },
      },
    },
  });

  if (!pdfReport) {
    throw notFound("PDF report not found");
  }

  const absolutePath = resolveStoredPdfPath(pdfReport.storagePath);

  if (!fs.existsSync(absolutePath)) {
    throw notFound("Stored PDF file was not found");
  }

  const accountName = pdfReport.audit.adAccount?.name || "audit";
  const safeAccountName = accountName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const fileName = `${safeAccountName || "audit"}-report-v${pdfReport.version}.pdf`;

  res.download(absolutePath, fileName);
};

export const uploadManualAuditFile = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const { platform, reportType } = req.body;

  if (!req.file) {
    throw badRequest("Upload file is required.");
  }

  if (!platform || !reportType) {
    throw badRequest("Platform and report type are required.");
  }

  const audit = await prisma.audit.findFirst({
    where: {
      id: req.params.auditId,
      organizationId,
    },
    include: {
      normalizedDataset: true,
    },
  });

  if (!audit) {
    throw notFound("Audit not found");
  }

  if (!audit.selectedPlatforms.includes(platform)) {
    throw badRequest("Selected platform is not part of this audit.");
  }

  const parsedUpload = await parseAndNormalizeUpload({
    filePath: req.file.path,
    originalName: req.file.originalname,
    platform,
    reportType,
  });

  const result = await prisma.$transaction(async (tx) => {
    const uploadedFile = await tx.uploadedFile.create({
      data: {
        auditId: audit.id,
        platform,
        reportType,
        originalName: req.file.originalname,
        storagePath: req.file.path,
        mimeType: req.file.mimetype,
        sizeBytes: req.file.size,
        status: parsedUpload.validation.isValid ? "VALIDATED" : "INVALID",
        validation: parsedUpload.validation,
      },
    });

    let normalizedDataset = audit.normalizedDataset;

    if (parsedUpload.validation.isValid) {
      const mergedDataset = mergeNormalizedDataset({
        existingDataset: audit.normalizedDataset,
        platform,
        reportType,
        uploadedFileId: uploadedFile.id,
        records: parsedUpload.records,
        uploadSummary: parsedUpload.summary,
        level: parsedUpload.level,
        breakdowns: parsedUpload.breakdowns,
      });

      normalizedDataset = await tx.normalizedDataset.upsert({
        where: {
          auditId: audit.id,
        },
        create: {
          auditId: audit.id,
          data: mergedDataset.data,
          summary: mergedDataset.summary,
        },
        update: {
          data: mergedDataset.data,
          summary: mergedDataset.summary,
        },
      });

      await tx.audit.update({
        where: {
          id: audit.id,
        },
        data: {
          status: "VALIDATING",
        },
      });
    }

    await tx.auditEvent.create({
      data: {
        auditId: audit.id,
        type: parsedUpload.validation.isValid
          ? "MANUAL_FILE_UPLOADED"
          : "MANUAL_FILE_INVALID",
        message: parsedUpload.validation.isValid
          ? "Manual upload file parsed and validated."
          : "Manual upload file failed validation.",
        metadata: {
          uploadedFileId: uploadedFile.id,
          platform,
          reportType,
          validation: parsedUpload.validation,
        },
      },
    });

    return {
      uploadedFile,
      normalizedDataset,
    };
  });

  res.status(201).json({
    status: "success",
    data: {
      uploadedFile: serializeUploadedFile(result.uploadedFile),
      normalizedDataset: result.normalizedDataset
        ? serializeNormalizedDataset(result.normalizedDataset)
        : null,
    },
  });
};

export const runAudit = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const audit = await prisma.audit.findFirst({
    where: { id: req.params.auditId, organizationId },
    include: {
      adAccount: true,
      uploadedFiles: true,
      normalizedDataset: { select: { id: true } },
    },
  });

  if (!audit) {
    throw notFound("Audit not found");
  }

  if (!audit.normalizedDataset) {
    throw badRequest(
      "Upload and validate at least one data file before running the audit."
    );
  }

  const validUploads = audit.uploadedFiles.filter(
    (uploadedFile) => uploadedFile.status === "VALIDATED"
  );

  // OAUTH audits store data in normalizedDataset (fetched via API) — no
  // uploaded files required. Only enforce the file check for MANUAL_UPLOAD.
  if (audit.dataSource === "MANUAL_UPLOAD" && validUploads.length === 0) {
    throw badRequest("No validated upload files are available for this audit.");
  }

  // Mark the audit as PROCESSING immediately so polling clients see the
  // transition. The actual heavy lifting (engine, AI, PDF) runs off-thread.
  const updatedAudit = await prisma.audit.update({
    where: { id: audit.id },
    data: { status: "PROCESSING", startedAt: new Date() },
    include: {
      adAccount: true,
      intakeResponses: true,
      uploadedFiles: { orderBy: { createdAt: "desc" } },
      normalizedDataset: true,
      ruleFindings: { orderBy: { createdAt: "desc" } },
      aiReport: true,
      pdfReports: { orderBy: { version: "desc" } },
    },
  });

  await prisma.auditEvent.create({
    data: {
      auditId: audit.id,
      type: "AUDIT_RUN_QUEUED",
      message: "Audit run queued for background processing.",
      metadata: { driver: getDriver() },
    },
  });

  const job = await enqueueRunAudit({
    auditId: audit.id,
    organizationId,
  });

  res.status(202).json({
    status: "queued",
    data: serializeAudit(updatedAudit),
    meta: {
      jobId: job.id,
      driver: job.driver,
      pollUrl: `/api/audits/${audit.id}`,
      hint: "Poll the audit endpoint until status is COMPLETED or FAILED.",
    },
  });
};

export const generateAiReport = async (req, res) => {
  const organizationId = getOrganizationId(req);

  // Plan gate: AI narrative is a paid feature. Free tier sees only the
  // deterministic report. We check BEFORE looking up the audit so the
  // 402 message is consistent regardless of which audit they tried.
  const { plan } = await resolveEffectivePlan(organizationId);
  const aiMode = getAiNarrativeMode(plan);
  if (aiMode === false) {
    throw paymentRequired(
      "AI narrative is not included in your current plan. Upgrade to Starter or higher to generate AI reports.",
      { plan: plan?.slug || "free", feature: "aiNarrative" }
    );
  }

  const audit = await prisma.audit.findFirst({
    where: { id: req.params.auditId, organizationId },
    select: {
      id: true,
      status: true,
      ruleFindings: { select: { id: true }, take: 1 },
    },
  });

  if (!audit) {
    throw notFound("Audit not found");
  }

  if (audit.status !== "COMPLETED" || audit.ruleFindings.length === 0) {
    throw badRequest(
      "Run the deterministic audit before generating an AI report."
    );
  }

  await prisma.auditEvent.create({
    data: {
      auditId: audit.id,
      type: "AI_REPORT_QUEUED",
      message: "AI report generation queued.",
      metadata: { driver: getDriver(), aiMode },
    },
  });

  const job = await enqueueGenerateAiReport({ auditId: audit.id });

  res.status(202).json({
    status: "queued",
    data: {
      auditId: audit.id,
      jobId: job.id,
      driver: job.driver,
      pollUrl: `/api/audits/${audit.id}`,
    },
  });
};

/**
 * Deep Audit — agentic, tool-using premium audit. Synchronous and flag-gated
 * (DEEP_AUDIT_ENABLED); 404s when the flag is off so the surface stays
 * invisible. Plan-feature gating (Agency/Agency+) is deferred — the AI cost cap
 * still applies via the route middleware.
 */
export const runDeepAuditReport = async (req, res) => {
  if (!isDeepAuditEnabled()) {
    throw notFound("Deep Audit is not available.");
  }

  const organizationId = getOrganizationId(req);
  const result = await runDeepAuditForAudit({
    auditId: req.params.auditId,
    organizationId,
  });

  res.json({ status: "success", data: result });
};

/**
 * Score-trend endpoint. Returns recent completed audits in chronological
 * order. The dashboard uses this to render a sparkline; the compare page
 * uses it to populate audit pickers.
 */
export const getAuditHistory = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const adAccountId =
    typeof req.query.adAccountId === "string" && req.query.adAccountId
      ? req.query.adAccountId
      : undefined;
  const platform =
    typeof req.query.platform === "string" && req.query.platform
      ? req.query.platform
      : undefined;
  const limitInput = Number(req.query.limit || 20);
  const limit = Number.isFinite(limitInput)
    ? Math.max(1, Math.min(100, Math.round(limitInput)))
    : 20;

  const trend = await fetchAuditTrend({
    organizationId,
    adAccountId,
    platform,
    limit,
  });

  res.json({
    status: "success",
    data: trend,
    meta: { count: trend.length, limit },
  });
};

/**
 * Side-by-side comparison endpoint. Both audits must belong to the caller's
 * org. The "left" is conventionally the older audit, "right" the newer —
 * the response uses that convention for delta direction.
 */
export const getAuditComparison = async (req, res) => {
  const organizationId = getOrganizationId(req);
  const leftAuditId =
    typeof req.query.left === "string" ? req.query.left : null;
  const rightAuditId =
    typeof req.query.right === "string" ? req.query.right : null;

  if (!leftAuditId || !rightAuditId) {
    throw badRequest("Both 'left' and 'right' audit IDs are required.");
  }

  if (leftAuditId === rightAuditId) {
    throw badRequest("Pick two different audits to compare.");
  }

  const comparison = await fetchAuditComparison({
    organizationId,
    leftAuditId,
    rightAuditId,
  });

  if (!comparison) {
    throw notFound("One or both audits were not found in your organization.");
  }

  res.json({
    status: "success",
    data: comparison,
  });
};

export const listAdAccounts = async (req, res) => {
  const organizationId = getOrganizationId(req);

  const adAccounts = await prisma.adAccount.findMany({
    where: {
      organizationId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  res.json({
    status: "success",
    data: adAccounts.map(serializeAdAccount),
  });
};
