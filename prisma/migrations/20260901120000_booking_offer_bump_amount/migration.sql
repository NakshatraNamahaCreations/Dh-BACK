-- Rupees the customer added on top of their previous "Book at your price"
-- offer when re-booking after no partner accepted. A bump creates a NEW
-- booking row, so this is the only way the partner-app can tell a
-- sweetened offer from a first attempt. Nullable: every existing row is
-- untouched and reads as "not bumped".
ALTER TABLE "bookings" ADD COLUMN "offerBumpAmount" INTEGER;
