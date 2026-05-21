-- AlterTable: add PAN and DL holder-name columns to partner_documents.
-- These are set by kyc.service.js at verification time so admin can
-- cross-check identity without re-calling the QuickeKYC API.
ALTER TABLE "partner_documents"
  ADD COLUMN IF NOT EXISTS "panHolderName" TEXT,
  ADD COLUMN IF NOT EXISTS "dlHolderName"  TEXT;
