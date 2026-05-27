-- Structured address-detail + receiver fields for the customer-app
-- "Add address details" screen. All nullable / additive, so this is
-- safe to apply to existing rows with no backfill.
ALTER TABLE "customer_addresses"
  ADD COLUMN "floor" TEXT,
  ADD COLUMN "building" TEXT,
  ADD COLUMN "landmark" TEXT,
  ADD COLUMN "receiverName" TEXT,
  ADD COLUMN "receiverPhone" TEXT;
