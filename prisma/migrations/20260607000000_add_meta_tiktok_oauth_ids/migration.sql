-- Add OAuth identity columns for Meta and TikTok sign-in/account linking.
ALTER TABLE "User" ADD COLUMN "metaId" TEXT;
ALTER TABLE "User" ADD COLUMN "tiktokId" TEXT;

CREATE UNIQUE INDEX "User_metaId_key" ON "User"("metaId");
CREATE UNIQUE INDEX "User_tiktokId_key" ON "User"("tiktokId");
