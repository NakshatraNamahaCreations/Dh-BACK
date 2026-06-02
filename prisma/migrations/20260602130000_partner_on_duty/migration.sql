-- Queryable mirror of the partner's real-time duty state (authoritative
-- source stays in Redis). Lets ops see/filter On Duty partners in SQL +
-- the admin partner list without touching Redis. Additive + nullable/
-- defaulted, safe on existing rows (all start off-duty until their next
-- presence ping flips the mirror).
ALTER TABLE "partners"
  ADD COLUMN "onDuty" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "onDutyChangedAt" TIMESTAMP(3);

-- Index so the common "list On Duty partners" / "On Duty in city X"
-- queries stay fast as the partner table grows.
CREATE INDEX "partners_onDuty_idx" ON "partners" ("onDuty");
