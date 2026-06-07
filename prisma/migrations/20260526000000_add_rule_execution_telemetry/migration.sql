-- CreateEnum
CREATE TYPE "RuleExecutionStatus" AS ENUM ('FIRED', 'PASSED', 'SKIPPED', 'ERROR');

-- CreateTable
CREATE TABLE "RuleExecution" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "status" "RuleExecutionStatus" NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "findingId" TEXT,
    "errorMessage" TEXT,
    "evidenceSummary" JSONB,
    "contextVersion" TEXT NOT NULL,
    "planTier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleExecution_auditId_idx" ON "RuleExecution"("auditId");

-- CreateIndex
CREATE INDEX "RuleExecution_ruleId_status_createdAt_idx" ON "RuleExecution"("ruleId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "RuleExecution_ruleId_createdAt_idx" ON "RuleExecution"("ruleId", "createdAt");

-- AddForeignKey
ALTER TABLE "RuleExecution" ADD CONSTRAINT "RuleExecution_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "Audit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
