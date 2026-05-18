-- Onboarding fee — admin sets per partner after call verification.
-- Null = not yet set; partner-app shows "awaiting fee" message.
ALTER TABLE "partners" ADD COLUMN "onboardingFeeAmount" INTEGER;
ALTER TABLE "partners" ADD COLUMN "onboardingFeeNote" TEXT;

-- Training — admin flips after partner completes the session.
-- approve() requires this AND payment to be done before activation.
ALTER TABLE "partners" ADD COLUMN "trainingCompletedAt" TIMESTAMP(3);
