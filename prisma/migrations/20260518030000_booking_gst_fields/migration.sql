-- Add GST and platform-fee columns to bookings.
-- grandTotal = total + gstAmount + platformFee (what customer actually pays).
-- Default 0 so existing rows are valid; backfill sets grandTotal = total.

ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "gstAmount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "platformFee" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "grandTotal"  INTEGER NOT NULL DEFAULT 0;

-- Back-fill: existing bookings had no fee split, so grandTotal = total.
UPDATE "bookings"
SET "grandTotal" = "total"
WHERE "grandTotal" = 0 AND "total" > 0;
