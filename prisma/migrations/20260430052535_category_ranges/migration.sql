/*
  Warnings:

  - You are about to drop the `suggested_ranges` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "suggested_ranges" DROP CONSTRAINT "suggested_ranges_serviceId_fkey";

-- DropTable
DROP TABLE "suggested_ranges";

-- CreateTable
CREATE TABLE "category_ranges" (
    "id" SERIAL NOT NULL,
    "categoryId" INTEGER NOT NULL,
    "minPct" INTEGER NOT NULL,
    "midPct" INTEGER NOT NULL,
    "maxPct" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_ranges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_ranges_categoryId_key" ON "category_ranges"("categoryId");

-- AddForeignKey
ALTER TABLE "category_ranges" ADD CONSTRAINT "category_ranges_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
