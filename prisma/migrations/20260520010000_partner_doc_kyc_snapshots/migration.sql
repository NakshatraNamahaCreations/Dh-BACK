-- AlterTable: capture verified profile snapshots per KYC document on
-- PartnerDocument. Previously only the holder name was extracted; the
-- rest of each QuickeKYC payload (Aadhaar DOB / gender / address, full
-- DL profile, bank account_exists / upi_id / remarks, etc.) was lost.
--
-- Adds:
--   * Aadhaar: dob, gender, address text
--   * PAN:     address (null until pan_advance is enabled — current
--              pan_lite endpoint doesn't return it)
--   * DL:      state, permanent + temporary addresses (+ zips), OLA,
--              citizenship, gender, father/husband, DOB, DOE, DOI, etc.
--   * Bank:    account_exists, upi_id, remarks, ifsc_details (jsonb)
--   * Raw payloads per doc (aadharRaw / panRaw / dlRaw / bankRaw — jsonb)
--     so admin can audit any field we don't have a dedicated column for
--     without re-calling QuickeKYC.
--
-- All nullable so existing partner_documents rows stay valid.
ALTER TABLE "partner_documents"
  ADD COLUMN IF NOT EXISTS "aadharDob"             TEXT,
  ADD COLUMN IF NOT EXISTS "aadharGender"          TEXT,
  ADD COLUMN IF NOT EXISTS "aadharAddress"         TEXT,
  ADD COLUMN IF NOT EXISTS "panAddress"            TEXT,
  ADD COLUMN IF NOT EXISTS "dlState"               TEXT,
  ADD COLUMN IF NOT EXISTS "dlPermanentAddress"    TEXT,
  ADD COLUMN IF NOT EXISTS "dlPermanentZip"        TEXT,
  ADD COLUMN IF NOT EXISTS "dlTemporaryAddress"    TEXT,
  ADD COLUMN IF NOT EXISTS "dlTemporaryZip"        TEXT,
  ADD COLUMN IF NOT EXISTS "dlCitizenship"         TEXT,
  ADD COLUMN IF NOT EXISTS "dlOlaName"             TEXT,
  ADD COLUMN IF NOT EXISTS "dlOlaCode"             TEXT,
  ADD COLUMN IF NOT EXISTS "dlGender"              TEXT,
  ADD COLUMN IF NOT EXISTS "dlFatherOrHusbandName" TEXT,
  ADD COLUMN IF NOT EXISTS "dlDob"                 TEXT,
  ADD COLUMN IF NOT EXISTS "dlDoe"                 TEXT,
  ADD COLUMN IF NOT EXISTS "dlTransportDoe"        TEXT,
  ADD COLUMN IF NOT EXISTS "dlDoi"                 TEXT,
  ADD COLUMN IF NOT EXISTS "dlTransportDoi"        TEXT,
  ADD COLUMN IF NOT EXISTS "bankAccountExists"     BOOLEAN,
  ADD COLUMN IF NOT EXISTS "bankUpiId"             TEXT,
  ADD COLUMN IF NOT EXISTS "bankRemarks"           TEXT,
  ADD COLUMN IF NOT EXISTS "bankIfscDetails"       JSONB,
  ADD COLUMN IF NOT EXISTS "aadharRaw"             JSONB,
  ADD COLUMN IF NOT EXISTS "panRaw"                JSONB,
  ADD COLUMN IF NOT EXISTS "dlRaw"                 JSONB,
  ADD COLUMN IF NOT EXISTS "bankRaw"               JSONB;
