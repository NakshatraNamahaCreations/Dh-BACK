-- Phase 2: admin roles + per-admin city scope.
--
-- Existing admins are seeded as SUPER so behaviour stays identical
-- until someone explicitly creates / re-assigns an admin as
-- CITY_MANAGER and attaches cities to them.

ALTER TABLE "admins"
  ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'SUPER';

CREATE TABLE IF NOT EXISTS "admin_city_assignments" (
  "id"        SERIAL PRIMARY KEY,
  "adminId"   INTEGER NOT NULL,
  "cityId"    INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_city_assignments_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "admins"("id") ON DELETE CASCADE,
  CONSTRAINT "admin_city_assignments_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_city_assignments_adminId_cityId_key"
  ON "admin_city_assignments" ("adminId", "cityId");

CREATE INDEX IF NOT EXISTS "admin_city_assignments_cityId_idx"
  ON "admin_city_assignments" ("cityId");
