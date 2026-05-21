-- Comprehensive sync: applies all schema.prisma definitions that were
-- never written to a migration file. Safe to re-run (IF NOT EXISTS / IF EXISTS guards).

-- ── 1. Enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "CouponDiscountType" AS ENUM ('PERCENT', 'FLAT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. partner_documents — missing columns ────────────────────────────────
ALTER TABLE "partner_documents"
  ADD COLUMN IF NOT EXISTS "aadharBackImageUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "aadharVerifiedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "panVerifiedAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "dlVerifiedAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bankVerifiedAt"      TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bankAccountHolder"   TEXT;

-- ── 3. bookings — coupon columns + nullable address fields ────────────────
ALTER TABLE "bookings"
  ADD COLUMN IF NOT EXISTS "couponId"       INTEGER,
  ADD COLUMN IF NOT EXISTS "couponCode"     TEXT,
  ADD COLUMN IF NOT EXISTS "couponDiscount" INTEGER;

ALTER TABLE "bookings"
  ALTER COLUMN "addressLabel" DROP NOT NULL,
  ALTER COLUMN "addressLine"  DROP NOT NULL,
  ALTER COLUMN "city"         DROP NOT NULL;

-- ── 4. coupons table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "coupons" (
  "id"            SERIAL PRIMARY KEY,
  "code"          TEXT                 NOT NULL,
  "description"   TEXT,
  "discountType"  "CouponDiscountType" NOT NULL,
  "discountValue" INTEGER              NOT NULL,
  "minOrderValue" INTEGER              NOT NULL DEFAULT 0,
  "maxDiscount"   INTEGER,
  "validFrom"     TIMESTAMP(3),
  "validUntil"    TIMESTAMP(3),
  "usageLimit"    INTEGER,
  "usedCount"     INTEGER              NOT NULL DEFAULT 0,
  "active"        BOOLEAN              NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3)         NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "coupons_code_key"
  ON "coupons"("code");
CREATE INDEX IF NOT EXISTS "coupons_active_code_idx"
  ON "coupons"("active", "code");
CREATE INDEX IF NOT EXISTS "coupons_validFrom_validUntil_idx"
  ON "coupons"("validFrom", "validUntil");

-- ── 5. partner_notifications table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS "partner_notifications" (
  "id"        SERIAL PRIMARY KEY,
  "partnerId" INTEGER      NOT NULL,
  "type"      TEXT         NOT NULL,
  "title"     TEXT         NOT NULL,
  "body"      TEXT         NOT NULL,
  "bookingId" INTEGER,
  "readAt"    TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "partner_notifications_partnerId_createdAt_idx"
  ON "partner_notifications"("partnerId", "createdAt");
CREATE INDEX IF NOT EXISTS "partner_notifications_partnerId_readAt_idx"
  ON "partner_notifications"("partnerId", "readAt");

-- ── 6. FK: bookings → coupons ─────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "bookings"
    ADD CONSTRAINT "bookings_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 7. FK: partner_notifications → partners ───────────────────────────────
DO $$ BEGIN
  ALTER TABLE "partner_notifications"
    ADD CONSTRAINT "partner_notifications_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 8. Index: bookings.paymentStatus ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS "bookings_paymentStatus_idx"
  ON "bookings"("paymentStatus");
