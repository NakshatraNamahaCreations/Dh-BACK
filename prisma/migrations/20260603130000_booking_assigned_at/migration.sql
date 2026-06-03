-- True partner-assignment timestamp (set on accept / admin assign),
-- drives the "Assigned" step time on the admin tracking timeline.
-- Distinct from updatedAt so it doesn't drift on later edits.
-- Additive + nullable, safe on existing rows.
ALTER TABLE "bookings" ADD COLUMN "assignedAt" TIMESTAMP(3);

-- Backfill existing assigned bookings: use updatedAt as a best-effort
-- assignment time for rows that already have a partner (better than
-- null for historical rows; new rows get the exact accept time).
UPDATE "bookings" SET "assignedAt" = "updatedAt" WHERE "partnerId" IS NOT NULL;
