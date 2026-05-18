/*
  Warnings:

  - You are about to drop the column `area` on the `surge_rules` table. All the data in the column will be lost.
  - Added the required column `serviceAreaId` to the `surge_rules` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "surge_rules" DROP COLUMN "area",
ADD COLUMN     "pincodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "serviceAreaId" INTEGER NOT NULL;

-- CreateTable
CREATE TABLE "service_areas" (
    "id" SERIAL NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "pincodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_areas_city_key" ON "service_areas"("city");

-- CreateIndex
CREATE INDEX "surge_rules_serviceAreaId_active_idx" ON "surge_rules"("serviceAreaId", "active");

-- AddForeignKey
ALTER TABLE "surge_rules" ADD CONSTRAINT "surge_rules_serviceAreaId_fkey" FOREIGN KEY ("serviceAreaId") REFERENCES "service_areas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
