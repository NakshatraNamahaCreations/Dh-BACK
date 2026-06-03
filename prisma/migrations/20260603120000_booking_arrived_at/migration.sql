-- Server-persisted "partner arrived" state. Set when the partner marks
-- arrival (between accept and job-start); survives app restart/reinstall
-- and is visible to the customer + admin. The booking status stays
-- CONFIRMED while arrived (arrival is a sub-state of en-route). Additive +
-- nullable, safe on existing rows.
ALTER TABLE "bookings" ADD COLUMN "arrivedAt" TIMESTAMP(3);
