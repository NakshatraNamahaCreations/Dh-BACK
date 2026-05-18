-- Drop flat document columns from partners (data moved to partner_documents)
ALTER TABLE "partners" DROP COLUMN IF EXISTS "aadharNumber";
ALTER TABLE "partners" DROP COLUMN IF EXISTS "panNumber";
ALTER TABLE "partners" DROP COLUMN IF EXISTS "dlNumber";
ALTER TABLE "partners" DROP COLUMN IF EXISTS "bankAccount";
ALTER TABLE "partners" DROP COLUMN IF EXISTS "bankIfsc";

-- CreateTable
CREATE TABLE "partner_documents" (
    "id" SERIAL NOT NULL,
    "partnerId" INTEGER NOT NULL,
    "aadharNumber" TEXT,
    "panNumber" TEXT,
    "dlNumber" TEXT,
    "bankAccount" TEXT,
    "bankIfsc" TEXT,
    "aadharImageUrl" TEXT,
    "panImageUrl" TEXT,
    "dlImageUrl" TEXT,
    "bankPassbookUrl" TEXT,
    "signatureUrl" TEXT,
    "kycStatus" TEXT,
    "kycProvider" TEXT,
    "kycVerifiedAt" TIMESTAMP(3),
    "kycRejectedAt" TIMESTAMP(3),
    "kycNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "partner_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "partner_documents_partnerId_key" ON "partner_documents"("partnerId");

-- AddForeignKey
ALTER TABLE "partner_documents" ADD CONSTRAINT "partner_documents_partnerId_fkey"
    FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;
