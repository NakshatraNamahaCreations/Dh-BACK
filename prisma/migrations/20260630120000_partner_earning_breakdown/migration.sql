-- Add partner earning breakdown columns (20/80 split, 18% Dhoond GST, 5% partner GST)
ALTER TABLE "partner_earnings"
  ADD COLUMN "dhoondCommission" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dhoondGst"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dhoondNet"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "partnerGst"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "netAmount"        INTEGER NOT NULL DEFAULT 0;
