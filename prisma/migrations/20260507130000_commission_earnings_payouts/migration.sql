-- CommissionRule: one row per category, default partner % is 80.
CREATE TABLE "commission_rules" (
    "id" SERIAL PRIMARY KEY,
    "categoryId" INTEGER NOT NULL,
    "partnerPct" INTEGER NOT NULL DEFAULT 80,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "commission_rules_categoryId_fkey"
        FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "commission_rules_categoryId_key" ON "commission_rules"("categoryId");

-- Payouts: one row per settlement; created BEFORE earnings table so the FK works.
CREATE TABLE "payouts" (
    "id" SERIAL PRIMARY KEY,
    "partnerId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "earningsCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "approvedBy" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "reference" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payouts_partnerId_fkey"
        FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE
);
CREATE INDEX "payouts_partnerId_status_idx" ON "payouts"("partnerId", "status");
CREATE INDEX "payouts_status_createdAt_idx" ON "payouts"("status", "createdAt");

-- PartnerEarning: one row per completed booking.
CREATE TABLE "partner_earnings" (
    "id" SERIAL PRIMARY KEY,
    "partnerId" INTEGER NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "bookingAmount" INTEGER NOT NULL,
    "commissionPct" INTEGER NOT NULL,
    "earnedAmount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payoutId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    CONSTRAINT "partner_earnings_partnerId_fkey"
        FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE,
    CONSTRAINT "partner_earnings_bookingId_fkey"
        FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE,
    CONSTRAINT "partner_earnings_payoutId_fkey"
        FOREIGN KEY ("payoutId") REFERENCES "payouts"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "partner_earnings_bookingId_key" ON "partner_earnings"("bookingId");
CREATE INDEX "partner_earnings_partnerId_status_idx" ON "partner_earnings"("partnerId", "status");
CREATE INDEX "partner_earnings_payoutId_idx" ON "partner_earnings"("payoutId");
CREATE INDEX "partner_earnings_createdAt_idx" ON "partner_earnings"("createdAt");
