ALTER TABLE "bookings" ADD COLUMN "partnerId" INTEGER;

CREATE INDEX "bookings_partnerId_idx" ON "bookings"("partnerId");

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "partners"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
