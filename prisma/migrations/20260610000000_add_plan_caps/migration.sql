-- Add cost + storage caps to SubscriptionPlan.
-- Both nullable: null = unlimited (existing behavior preserved).

ALTER TABLE "SubscriptionPlan"
  ADD COLUMN "aiMonthlyUsdCap" DECIMAL(10,2),
  ADD COLUMN "storageMbCap"    INTEGER;
