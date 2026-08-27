-- How a service area's `pincodes` list should be interpreted.
--   'whitelist' (default) = ONLY those pincodes are serviceable (legacy behaviour)
--   'extra'               = the whole city PLUS those pincodes (fringe areas a
--                           geocoder reports under a different city name)
-- Defaulting to 'whitelist' keeps every existing area behaving exactly as before.
ALTER TABLE "service_areas" ADD COLUMN "pincodeMode" TEXT NOT NULL DEFAULT 'whitelist';
