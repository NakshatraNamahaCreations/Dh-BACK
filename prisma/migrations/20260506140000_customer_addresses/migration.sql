-- Saved addresses (Home, Work, custom) for a customer. Source of truth;
-- Booking keeps its own snapshot fields so history is immutable.
CREATE TABLE IF NOT EXISTS "customer_addresses" (
  "id"          SERIAL PRIMARY KEY,
  "customerId"  INTEGER NOT NULL,
  "label"       TEXT NOT NULL,
  "addressLine" TEXT NOT NULL,
  "city"        TEXT NOT NULL,
  "pincode"     TEXT,
  "lat"         DOUBLE PRECISION,
  "lng"         DOUBLE PRECISION,
  "isDefault"   BOOLEAN NOT NULL DEFAULT false,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "customer_addresses_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "customer_addresses_customerId_isDefault_idx"
  ON "customer_addresses"("customerId", "isDefault");

-- Bookings now point at the saved address row (nullable). The booking's
-- own addressLine/city/lat/lng snapshot stays — that's the historical
-- record. SET NULL on delete so a customer removing a saved address
-- doesn't cascade-delete their booking history.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "customerAddressId" INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_customerAddressId_fkey'
  ) THEN
    ALTER TABLE "bookings"
      ADD CONSTRAINT "bookings_customerAddressId_fkey"
      FOREIGN KEY ("customerAddressId")
      REFERENCES "customer_addresses"("id") ON DELETE SET NULL;
  END IF;
END $$;
