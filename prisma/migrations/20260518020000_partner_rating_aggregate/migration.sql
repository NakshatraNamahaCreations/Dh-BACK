-- Add denormalised rating aggregate columns to partners.
-- avgRating and ratingCount are recomputed by the application layer
-- after every BookingRating upsert so reads never need a GROUP BY.

ALTER TABLE "partners"
  ADD COLUMN "avgRating"   DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN "ratingCount" INTEGER          NOT NULL DEFAULT 0;

-- Back-fill existing ratings so historical data is consistent.
UPDATE "partners" p
SET
  "avgRating"   = ROUND(CAST(sub.avg_stars AS numeric), 1),
  "ratingCount" = sub.cnt
FROM (
  SELECT
    "partnerId",
    AVG("stars")   AS avg_stars,
    COUNT(*)       AS cnt
  FROM "booking_ratings"
  GROUP BY "partnerId"
) sub
WHERE p."id" = sub."partnerId";
