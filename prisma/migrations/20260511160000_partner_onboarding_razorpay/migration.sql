-- Razorpay audit columns for the onboarding-fee payment. Stored on
-- the Partner row directly because the onboarding fee is a one-time
-- charge that doesn't pass through the bookings/payments table.
ALTER TABLE "partners"
  ADD COLUMN IF NOT EXISTS "onboardingFeeOrderId"   TEXT,
  ADD COLUMN IF NOT EXISTS "onboardingFeePaymentId" TEXT;
