import fs from "fs";
import path from "path";
import multer from "multer";
import { randomUUID } from "crypto";
import { badRequest } from "../../utils/appError.js";

const uploadRoot = process.env.UPLOAD_DIR || path.join(process.cwd(), "uploads");
const auditUploadDir = path.join(uploadRoot, "audits");
const allowedExtensions = new Set([".csv", ".json", ".xlsx"]);

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    fs.mkdirSync(auditUploadDir, { recursive: true });
    cb(null, auditUploadDir);
  },
  filename: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${randomUUID()}${extension}`);
  },
});

export const uploadAuditFile = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_FILE_SIZE_BYTES || 10 * 1024 * 1024),
  },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();

    if (!allowedExtensions.has(extension)) {
      cb(badRequest("Unsupported file type. Upload CSV, JSON, or XLSX."));
      return;
    }

    cb(null, true);
  },
}).single("file");
