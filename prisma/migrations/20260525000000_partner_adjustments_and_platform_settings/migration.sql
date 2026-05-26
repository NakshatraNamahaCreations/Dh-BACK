-- PartnerAdjustment: debits/credits against a partner's payout that
-- aren't per-booking earnings. Today: cancellation penalties.
CREATE TABLE "partner_adjustments" (
    "id" SERIAL PRIMARY KEY,
    "partnerId" INTEGER NOT NULL,
    "bookingId" INTEGER,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payoutId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_adjustments_partnerId_fkey"
        FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE,
    CONSTRAINT "partner_adjustments_payoutId_fkey"
        FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL
);
CREATE INDEX "partner_adjustments_partnerId_status_idx" ON "partner_adjustments"("partnerId", "status");
CREATE INDEX "partner_adjustments_partnerId_type_createdAt_idx" ON "partner_adjustments"("partnerId", "type", "createdAt");
CREATE INDEX "partner_adjustments_payoutId_idx" ON "partner_adjustments"("payoutId");

-- PlatformSetting: key-value JSON store for platform-wide settings
-- (cancellation_policy, refund_policy, …).
CREATE TABLE "platform_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("key")
);
