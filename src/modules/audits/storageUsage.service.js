/**
 * Storage usage queries — sum bytes used per organization across
 * uploaded files and generated PDFs. Used by the storage-cap middleware.
 */

import { prisma } from "../../lib/prisma.js";

/**
 * Returns bytes used by an organization. Best-effort: uploaded files have
 * a sizeBytes column we sum directly; PDFs are estimated at 500 KB each
 * unless we add a sizeBytes column to PdfReport in v1.1.
 */
export const sumOrgStorageBytes = async ({ organizationId }) => {
  if (!organizationId) return 0;

  const [uploadAgg, pdfCount] = await Promise.all([
    prisma.uploadedFile.aggregate({
      where: {
        audit: { organizationId },
      },
      _sum: { sizeBytes: true },
    }),
    prisma.pdfReport.count({
      where: { audit: { organizationId } },
    }),
  ]);

  const uploadBytes = Number(uploadAgg._sum?.sizeBytes ?? 0);
  // 500 KB rough average per PDF until we record actual sizes.
  const pdfBytes = pdfCount * 500 * 1024;
  return uploadBytes + pdfBytes;
};

export const bytesToMb = (bytes) => bytes / (1024 * 1024);
