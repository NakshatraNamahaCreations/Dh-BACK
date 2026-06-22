-- Allow permanently deleting a service that already has bookings.
-- The booking item's link to the service becomes nullable and is cleared
-- (SET NULL) when the service is deleted, while the booking item itself — and
-- its serviceName/basePrice snapshot — is preserved so order history stays
-- accurate.

-- DropForeignKey
ALTER TABLE "booking_items" DROP CONSTRAINT "booking_items_serviceId_fkey";

-- AlterTable
ALTER TABLE "booking_items" ALTER COLUMN "serviceId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE SET NULL ON UPDATE CASCADE;
