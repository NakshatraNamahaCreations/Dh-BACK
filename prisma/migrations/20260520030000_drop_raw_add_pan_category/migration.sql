-- Drop the raw QuickeKYC payload columns — every field they held is
-- already captured by a dedicated flat column on partner_documents,
-- so the JSON blobs are pure duplication. The one exception was the
-- PAN `category` field (person / company / huf / firm / etc.), which
-- moves to its own flat column so we don't keep a Json column just
-- for one string.
ALTER TABLE "partner_documents"
  DROP COLUMN IF EXISTS "aadharRaw",
  DROP COLUMN IF EXISTS "panRaw",
  DROP COLUMN IF EXISTS "dlRaw",
  DROP COLUMN IF EXISTS "bankRaw",
  ADD  COLUMN IF NOT EXISTS "panCategory" TEXT;
