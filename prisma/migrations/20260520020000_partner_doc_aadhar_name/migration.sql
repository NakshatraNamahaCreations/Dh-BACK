-- AlterTable: persist Aadhaar holder name on partner_documents.
-- Previously the UIDAI-verified name was stored inside kycNote (a TEXT
-- column holding stringified JSON), which (a) collided with non-Aadhaar
-- doc snapshots and (b) was lost the moment kycNote writes were removed
-- from submitAadhaarOtp. The dedicated column matches the existing
-- panHolderName / dlHolderName / bankAccountHolder pattern.
ALTER TABLE "partner_documents"
  ADD COLUMN IF NOT EXISTS "aadharName" TEXT;
