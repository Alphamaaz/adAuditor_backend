-- CreateTable
CREATE TABLE "DeepAuditReport" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "report" JSONB NOT NULL,
    "reasoningTrace" JSONB NOT NULL,
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeepAuditReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeepAuditReport_auditId_key" ON "DeepAuditReport"("auditId");

-- AddForeignKey
ALTER TABLE "DeepAuditReport" ADD CONSTRAINT "DeepAuditReport_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
