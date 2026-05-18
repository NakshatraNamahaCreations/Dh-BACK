-- States: ~28 + UTs in India. Seeded separately via npm run seed:geography.
CREATE TABLE "states" (
    "id"        SERIAL PRIMARY KEY,
    "name"      TEXT    NOT NULL UNIQUE,
    "code"      TEXT,
    "active"    BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- Cities — operational unit. Same name allowed across states (Hyderabad
-- exists in TS and AP) but unique within a state.
CREATE TABLE "cities" (
    "id"         SERIAL PRIMARY KEY,
    "name"       TEXT    NOT NULL,
    "stateId"    INTEGER NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "lat"        DOUBLE PRECISION,
    "lng"        DOUBLE PRECISION,
    "launchedAt" TIMESTAMP(3),
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cities_stateId_fkey"
        FOREIGN KEY ("stateId") REFERENCES "states"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "cities_name_stateId_key" ON "cities"("name", "stateId");
CREATE INDEX "cities_stateId_active_idx" ON "cities"("stateId", "active");

-- Add nullable cityId FK to every place we want to slice by geography.
-- Nullable on day one; backfill script populates these from the existing
-- free-text `city` columns. Once clean we'll add `NOT NULL` and drop the
-- free-text columns in a follow-up migration.

ALTER TABLE "bookings" ADD COLUMN "cityId" INTEGER;
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL;
CREATE INDEX "bookings_cityId_createdAt_idx" ON "bookings"("cityId", "createdAt");

ALTER TABLE "partners" ADD COLUMN "cityId" INTEGER;
ALTER TABLE "partners" ADD CONSTRAINT "partners_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL;
CREATE INDEX "partners_cityId_idx" ON "partners"("cityId");

ALTER TABLE "customer_addresses" ADD COLUMN "cityId" INTEGER;
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL;
CREATE INDEX "customer_addresses_cityId_idx" ON "customer_addresses"("cityId");

ALTER TABLE "service_areas" ADD COLUMN "cityId" INTEGER;
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_cityId_fkey"
    FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL;
CREATE INDEX "service_areas_cityId_idx" ON "service_areas"("cityId");
