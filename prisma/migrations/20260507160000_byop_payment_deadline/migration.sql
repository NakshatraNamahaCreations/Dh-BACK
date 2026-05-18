-- BYOP pay-after-accept window. Set on partner accept for bookings
-- with `offeredPrice`; null for non-BYOP bookings (pay upfront).
ALTER TABLE "bookings" ADD COLUMN "paymentDeadlineAt" TIMESTAMP(3);
CREATE INDEX "bookings_paymentDeadlineAt_idx" ON "bookings"("paymentDeadlineAt");
