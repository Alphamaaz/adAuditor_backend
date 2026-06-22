-- AlterTable
ALTER TABLE "AdAccount" ADD COLUMN     "lastAutoAuditAt" TIMESTAMP(3),
ADD COLUMN     "monitoringEnabled" BOOLEAN NOT NULL DEFAULT false;
