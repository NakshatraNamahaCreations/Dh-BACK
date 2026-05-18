-- ────────────────────────────────────────────────────────────────────────
-- Bookings: ensure the rollup + legacy razorpay columns exist before the
-- backfill SELECT below references them.
--
-- Older dev databases had these columns added out-of-band (an early
-- `prisma db push` or hand-applied ALTER), so they exist in production
-- but were never expressed in a migration. That breaks `prisma migrate
-- dev` because the shadow database replays migrations from scratch and
-- has no idea the columns should be there. Adding them here with
-- `IF NOT EXISTS` is idempotent — no-ops on the existing dev DB,
-- creates them in shadow DB.
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "paymentStatus"    TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "paymentMethod"    TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "paidAt"           TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "razorpayOrderId"  TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "razorpayPaymentId" TEXT;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "razorpaySignature" TEXT;

-- Create the payments table — one row per payment attempt against a Booking.
CREATE TABLE IF NOT EXISTS "payments" (
  "id"                SERIAL PRIMARY KEY,
  "bookingId"         INTEGER NOT NULL,
  "amount"            INTEGER NOT NULL,
  "currency"          TEXT NOT NULL DEFAULT 'INR',
  "status"            TEXT NOT NULL,
  "method"            TEXT,
  "failureReason"     TEXT,
  "provider"          TEXT NOT NULL DEFAULT 'razorpay',
  "providerOrderId"   TEXT,
  "providerPaymentId" TEXT,
  "providerSignature" TEXT,
  "paidAt"            TIMESTAMP(3),
  "refundedAt"        TIMESTAMP(3),
  "refundAmount"      INTEGER,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payments_bookingId_fkey"
    FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "payments_bookingId_createdAt_idx"
  ON "payments"("bookingId", "createdAt");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");
CREATE INDEX IF NOT EXISTS "payments_providerOrderId_idx"
  ON "payments"("providerOrderId");

-- Backfill: every existing booking that already has a Razorpay order id
-- becomes one Payment row, preserving order id / payment id / signature
-- and the paid-at timestamp. Bookings with no Razorpay order id have
-- never been charged, so they get no Payment row — Booking.paymentStatus
-- stays at 'unpaid'.
INSERT INTO "payments" (
  "bookingId", "amount", "currency", "status", "method",
  "provider", "providerOrderId", "providerPaymentId", "providerSignature",
  "paidAt", "createdAt", "updatedAt"
)
SELECT
  b."id",
  COALESCE(b."offeredPrice", b."total"),
  'INR',
  CASE
    WHEN b."paymentStatus" IN ('pending', 'paid', 'failed', 'refunded')
      THEN b."paymentStatus"
    ELSE 'pending'
  END,
  COALESCE(b."paymentMethod", 'razorpay'),
  'razorpay',
  b."razorpayOrderId",
  b."razorpayPaymentId",
  b."razorpaySignature",
  b."paidAt",
  COALESCE(b."paidAt", b."createdAt"),
  b."updatedAt"
FROM "bookings" b
WHERE b."razorpayOrderId" IS NOT NULL;

-- Now that history is preserved in `payments`, drop the Razorpay-specific
-- columns from `bookings`. The rollup columns (paymentStatus, paymentMethod,
-- paidAt) stay — they are kept in sync by the payment service.
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "razorpayOrderId";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "razorpayPaymentId";
ALTER TABLE "bookings" DROP COLUMN IF EXISTS "razorpaySignature";
