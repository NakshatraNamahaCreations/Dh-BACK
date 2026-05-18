-- Persist partner onboarding/payment state and add indexes needed for a large
-- vendor directory and admin review queue.
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "onboardingFeePaidAt" TIMESTAMP(3);
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "rejectedReason" TEXT;

CREATE INDEX IF NOT EXISTS "partners_isVerified_createdAt_idx" ON "partners"("isVerified", "createdAt");
CREATE INDEX IF NOT EXISTS "partners_isActive_isVerified_idx" ON "partners"("isActive", "isVerified");
CREATE INDEX IF NOT EXISTS "partners_categoryId_idx" ON "partners"("categoryId");
CREATE INDEX IF NOT EXISTS "partners_city_idx" ON "partners"("city");

CREATE INDEX IF NOT EXISTS "partner_documents_kycStatus_idx" ON "partner_documents"("kycStatus");
CREATE INDEX IF NOT EXISTS "partner_documents_panNumber_idx" ON "partner_documents"("panNumber");
CREATE INDEX IF NOT EXISTS "partner_documents_aadharNumber_idx" ON "partner_documents"("aadharNumber");
CREATE INDEX IF NOT EXISTS "partner_documents_bankIfsc_idx" ON "partner_documents"("bankIfsc");
