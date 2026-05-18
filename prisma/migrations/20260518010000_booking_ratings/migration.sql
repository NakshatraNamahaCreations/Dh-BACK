-- CreateTable: booking_ratings
-- Stores customer ratings (1-5 stars + optional comment) for completed bookings.
-- One row per booking (@unique on bookingId). Null until the customer submits.

CREATE TABLE "booking_ratings" (
  "id"         SERIAL PRIMARY KEY,
  "bookingId"  INTEGER NOT NULL,
  "partnerId"  INTEGER NOT NULL,
  "customerId" INTEGER NOT NULL,
  "stars"      INTEGER NOT NULL,
  "comment"    TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "booking_ratings_bookingId_key" UNIQUE ("bookingId")
);

-- Foreign keys
ALTER TABLE "booking_ratings"
  ADD CONSTRAINT "booking_ratings_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booking_ratings"
  ADD CONSTRAINT "booking_ratings_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booking_ratings"
  ADD CONSTRAINT "booking_ratings_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes for partner/customer aggregate queries
CREATE INDEX "booking_ratings_partnerId_createdAt_idx"  ON "booking_ratings"("partnerId",  "createdAt");
CREATE INDEX "booking_ratings_customerId_createdAt_idx" ON "booking_ratings"("customerId", "createdAt");
