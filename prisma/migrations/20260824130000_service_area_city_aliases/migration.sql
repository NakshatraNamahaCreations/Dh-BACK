-- Alternate locality names that resolve to a service area (lowercased).
-- Reverse-geocoders return fringe names like "Bommasandra" / "Anekal Taluk"
-- instead of the parent city, and Google omits postal_code at some
-- coordinates, so pincode rules alone can't cover those addresses.
-- Empty array = current behaviour (match on city name only).
ALTER TABLE "service_areas" ADD COLUMN "cityAliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
