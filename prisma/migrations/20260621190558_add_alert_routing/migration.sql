-- AlterTable
ALTER TABLE "AdAccount" ADD COLUMN     "assignedUserId" TEXT;

-- AlterTable
ALTER TABLE "OrganizationMember" ADD COLUMN     "alertsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "AdAccount_assignedUserId_idx" ON "AdAccount"("assignedUserId");

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
