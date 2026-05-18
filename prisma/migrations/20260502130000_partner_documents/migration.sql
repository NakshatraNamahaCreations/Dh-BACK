-- AlterTable: add document fields to partners
ALTER TABLE "partners" ADD COLUMN "aadharNumber" TEXT;
ALTER TABLE "partners" ADD COLUMN "panNumber" TEXT;
ALTER TABLE "partners" ADD COLUMN "dlNumber" TEXT;
ALTER TABLE "partners" ADD COLUMN "bankAccount" TEXT;
ALTER TABLE "partners" ADD COLUMN "bankIfsc" TEXT;
