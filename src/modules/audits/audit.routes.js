import { Router } from "express";
import { requireAuth } from "../../middlewares/auth.js";
import { validateBody } from "../../middlewares/validate.js";
import {
  enforceAuditRunLimits,
  enforceAuditSetupLimits,
  enforceDataSourceAllowed,
} from "../../middlewares/planEnforcement.js";
import {
  expensiveRateLimit,
  uploadRateLimit,
} from "../../middlewares/rateLimit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import {
  createAuditSetupSchema,
  submitPlatformIntakeSchema,
} from "./audit.schemas.js";
import {
  createAuditSetup,
  downloadPdfReport,
  generateAiReport,
  generatePdfReport,
  getAudit,
  getAuditComparison,
  getAuditHistory,
  listAdAccounts,
  listAudits,
  runAudit,
  submitPlatformIntake,
  uploadManualAuditFile,
} from "./audit.controller.js";
import { uploadAuditFile } from "./upload.middleware.js";

const router = Router();

router.use(requireAuth);

router.get("/", asyncHandler(listAudits));
router.post(
  "/setup",
  validateBody(createAuditSetupSchema),
  ...enforceAuditSetupLimits,
  enforceDataSourceAllowed,
  asyncHandler(createAuditSetup)
);
router.get("/ad-accounts", asyncHandler(listAdAccounts));
router.get("/history", asyncHandler(getAuditHistory));
router.get("/compare", asyncHandler(getAuditComparison));
router.post(
  "/:auditId/platform-intake",
  validateBody(submitPlatformIntakeSchema),
  asyncHandler(submitPlatformIntake)
);
router.post(
  "/:auditId/uploads",
  uploadRateLimit,
  uploadAuditFile,
  asyncHandler(uploadManualAuditFile)
);
router.post(
  "/:auditId/run",
  expensiveRateLimit,
  ...enforceAuditRunLimits,
  asyncHandler(runAudit)
);
router.post(
  "/:auditId/ai-report",
  expensiveRateLimit,
  asyncHandler(generateAiReport)
);
router.post("/:auditId/pdf", asyncHandler(generatePdfReport));
router.get("/:auditId/pdf/:pdfReportId/download", asyncHandler(downloadPdfReport));
router.get("/:auditId", asyncHandler(getAudit));

export default router;
