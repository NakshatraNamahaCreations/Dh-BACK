-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "addOnIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'booking';

-- CreateTable
CREATE TABLE "booking_add_ons" (
    "id" SERIAL NOT NULL,
    "bookingId" INTEGER NOT NULL,
    "serviceId" INTEGER,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "durationMins" INTEGER,
    "image" TEXT,
    "isCustom" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "paidAt" TIMESTAMP(3),
    "addedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_add_ons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_add_ons_bookingId_idx" ON "booking_add_ons"("bookingId");

-- AddForeignKey
ALTER TABLE "booking_add_ons" ADD CONSTRAINT "booking_add_ons_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_add_ons" ADD CONSTRAINT "booking_add_ons_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
