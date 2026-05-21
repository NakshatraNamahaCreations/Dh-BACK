ALTER TABLE "partner_documents"
ADD COLUMN "dlSkippedAt" TIMESTAMP(3),
ADD COLUMN "dlSkipReason" TEXT;
