-- PAN can be SKIPPED during onboarding (mirrors the existing DL skip), then
-- completed later from the partner's profile or by an admin. Additive +
-- nullable, safe on existing rows (all start null = not skipped).
ALTER TABLE "partner_documents"
  ADD COLUMN "panSkippedAt"  TIMESTAMP(3),
  ADD COLUMN "panSkipReason" TEXT;
