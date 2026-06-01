-- Human-facing Booking ID: DHND + DDMMYY + zero-padded daily sequence.
-- Internal autoincrement `id` stays the FK/URL key; `bookingRef` is the
-- display id, uniquely indexed so it's searchable and collision-free.

-- 1. Additive column (nullable so this is safe on existing rows).
ALTER TABLE "bookings" ADD COLUMN "bookingRef" TEXT;

-- 2. Per-day sequence source, mirrored by the BookingRefCounter model.
CREATE TABLE "booking_ref_counters" (
  "day" TEXT NOT NULL,
  "seq" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "booking_ref_counters_pkey" PRIMARY KEY ("day")
);

-- 3. Backfill existing bookings. Number them per calendar day in
--    createdAt order (oldest = 001) so the suffix is stable and
--    matches the order the bookings were actually placed. Dates use
--    Asia/Kolkata so the DDMMYY component lines up with the IST
--    business day the customer saw, regardless of server TZ.
WITH numbered AS (
  SELECT
    "id",
    to_char("createdAt" AT TIME ZONE 'Asia/Kolkata', 'DDMMYY') AS day,
    row_number() OVER (
      PARTITION BY to_char("createdAt" AT TIME ZONE 'Asia/Kolkata', 'DDMMYY')
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS seq
  FROM "bookings"
)
UPDATE "bookings" b
SET "bookingRef" = 'DHND' || n.day || lpad(n.seq::text, 3, '0')
FROM numbered n
WHERE b."id" = n."id";

-- 4. Seed the counter so new bookings continue after the highest
--    backfilled sequence for each day (no reuse of a backfilled ref).
--    The per-day sequence ran 1..N in createdAt order, so the highest
--    consumed number for a day is simply that day's booking count.
INSERT INTO "booking_ref_counters" ("day", "seq")
SELECT
  to_char("createdAt" AT TIME ZONE 'Asia/Kolkata', 'DDMMYY') AS day,
  count(*) AS seq
FROM "bookings"
GROUP BY to_char("createdAt" AT TIME ZONE 'Asia/Kolkata', 'DDMMYY');

-- 5. Unique index — enforced now that every existing row has a value.
CREATE UNIQUE INDEX "bookings_bookingRef_key" ON "bookings" ("bookingRef");
