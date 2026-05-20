-- AlterTable: make passwordHash nullable for Google OAuth users
ALTER TABLE "User" ALTER COLUMN "passwordHash" DROP NOT NULL;

-- AlterTable: add googleId column
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;

-- CreateIndex: unique constraint on googleId
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
