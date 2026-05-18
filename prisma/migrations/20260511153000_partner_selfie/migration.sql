-- Selfie / profile photo column for PartnerDocument. Captured via
-- device camera during onboarding and editable from the partner-app
-- profile screen.
ALTER TABLE "partner_documents" ADD COLUMN IF NOT EXISTS "selfieUrl" TEXT;
