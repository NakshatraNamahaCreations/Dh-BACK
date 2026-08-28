-- Partial index for the 5-minute abandoned-booking purge
-- (dispatcher `purge_abandoned` job). It indexes ONLY rows matching the
-- purge predicate (cancelled + never paid), a set the sweep itself keeps
-- draining -- so the index stays near-empty and each sweep is an
-- index-only touch regardless of how large `bookings` grows.
CREATE INDEX IF NOT EXISTS bookings_abandoned_purge_idx
ON bookings ("updatedAt")
WHERE status = 'CANCELLED' AND "paidAt" IS NULL;
