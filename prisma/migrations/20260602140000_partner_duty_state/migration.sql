-- Richer 3-state live duty status (superset of the onDuty boolean):
--   'off_duty'  — not working
--   'available' — on duty, free, waiting for a job
--   'busy'      — on duty and on an accepted/in-progress job
-- Mirrors the Redis presence + partner:active flag, same best-effort
-- reconciliation as onDuty. Additive + defaulted, safe on existing rows.
ALTER TABLE "partners"
  ADD COLUMN "dutyState" TEXT NOT NULL DEFAULT 'off_duty';

-- Backfill from the existing onDuty mirror so the new column is
-- consistent on day one (busy is set later by the accept/complete flow).
UPDATE "partners" SET "dutyState" = 'available' WHERE "onDuty" = true;

CREATE INDEX "partners_dutyState_idx" ON "partners" ("dutyState");
