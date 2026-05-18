-- Suspension audit on Partner. Set when admin pauses an account via
-- the Suspend action; cleared on Resume. Distinct from
-- `rejectedReason` which captures onboarding rejection — semantically
-- a different state (rejected = never made it to active; suspended
-- = was active, then blocked).
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "suspendReason" TEXT;
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "suspendedAt" TIMESTAMP(3);
