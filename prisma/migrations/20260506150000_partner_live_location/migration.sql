-- Live partner location for customer-side tracking.
-- Three columns + one index. Updated by `POST /tracking/me/location`
-- while the partner is on an accepted booking; read by the customer
-- through `GET /tracking/bookings/:id`.
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "currentLat" DOUBLE PRECISION;
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "currentLng" DOUBLE PRECISION;
ALTER TABLE "partners" ADD COLUMN IF NOT EXISTS "lastLocationAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "partners_currentLat_currentLng_idx"
  ON "partners"("currentLat", "currentLng");
