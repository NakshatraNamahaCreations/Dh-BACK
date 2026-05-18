ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "dispatchStatus" TEXT NOT NULL DEFAULT 'waiting';
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "dispatchStartedAt" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "dispatchExpiresAt" TIMESTAMP(3);
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "dispatchRadiusKm" INTEGER;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "dispatchWave" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "noPartnerReason" TEXT;

CREATE INDEX IF NOT EXISTS "bookings_dispatchStatus_dispatchStartedAt_idx" ON "bookings"("dispatchStatus", "dispatchStartedAt");
CREATE INDEX IF NOT EXISTS "bookings_isInstant_createdAt_idx" ON "bookings"("isInstant", "createdAt");
