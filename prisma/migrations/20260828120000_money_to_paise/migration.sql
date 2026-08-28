-- ============================================================================
-- MONEY → PAISE
--
-- Every money column moves from whole rupees to integer PAISE (₹379.24 →
-- 37924). Whole-rupee storage silently dropped the fractional part of every
-- settlement (a ₹499 job owed the partner ₹379.24 but recorded ₹379), and
-- that rounding never nets back.
--
-- GUARDED: the whole conversion runs only once. Re-running is a no-op, because
-- applying it twice would multiply every amount by 10,000.
--
-- MUST be deployed together with the paise-aware application code. Running it
-- against the old rupee code makes every amount display 100x too large.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_settings WHERE key = 'money_unit_paise') THEN
    RAISE NOTICE 'money_to_paise already applied — skipping';
    RETURN;
  END IF;

  UPDATE partners            SET "onboardingFeeAmount" = "onboardingFeeAmount" * 100
                             WHERE "onboardingFeeAmount" IS NOT NULL;

  UPDATE services            SET "basePrice" = "basePrice" * 100;
  UPDATE services            SET "originalPrice" = "originalPrice" * 100
                             WHERE "originalPrice" IS NOT NULL;
  UPDATE booking_items       SET "basePrice" = "basePrice" * 100;
  UPDATE booking_add_ons     SET "price"     = "price" * 100;

  UPDATE bookings SET
    "subtotal"    = "subtotal" * 100,
    "discount"    = "discount" * 100,
    "total"       = "total" * 100,
    "gstAmount"   = "gstAmount" * 100,
    "platformFee" = "platformFee" * 100,
    "grandTotal"  = "grandTotal" * 100,
    "offeredPrice"= COALESCE("offeredPrice", 0) * 100,
    "couponDiscount" = COALESCE("couponDiscount", 0) * 100;
  UPDATE bookings SET "couponDiscount" = NULL WHERE "couponDiscount" = 0;
  UPDATE bookings SET "offeredPrice" = NULL WHERE "offeredPrice" = 0;

  UPDATE payments SET
    "amount"       = "amount" * 100,
    "refundAmount" = COALESCE("refundAmount", 0) * 100;
  UPDATE payments SET "refundAmount" = NULL WHERE "refundAmount" = 0;

  UPDATE partner_earnings SET
    "bookingAmount"    = "bookingAmount" * 100,
    "earnedAmount"     = "earnedAmount" * 100,
    "dhoondCommission" = "dhoondCommission" * 100,
    "dhoondGst"        = "dhoondGst" * 100,
    "dhoondNet"        = "dhoondNet" * 100,
    "partnerGst"       = "partnerGst" * 100,
    "netAmount"        = "netAmount" * 100;

  UPDATE payouts             SET "amount" = "amount" * 100;
  UPDATE partner_adjustments SET "amount" = "amount" * 100;

  -- Coupons: `discountValue` is a PERCENTAGE for PERCENT codes (must NOT be
  -- scaled) and rupees only for FLAT codes.
  UPDATE coupons SET "discountValue" = "discountValue" * 100 WHERE "discountType" = 'FLAT';
  UPDATE coupons SET "minOrderValue" = "minOrderValue" * 100;
  UPDATE coupons SET "maxDiscount"   = "maxDiscount" * 100 WHERE "maxDiscount" IS NOT NULL;

  -- Policy thresholds live as JSON blobs in platform_settings.
  UPDATE platform_settings
     SET value = jsonb_set(value, '{partnerPenalty}',
                 to_jsonb(COALESCE((value->>'partnerPenalty')::int, 0) * 100))
   WHERE key = 'cancellation_policy' AND value->>'partnerPenalty' IS NOT NULL;

  UPDATE platform_settings
     SET value = jsonb_set(
                   jsonb_set(value, '{autoApproveBelow}',
                     to_jsonb(COALESCE((value->>'autoApproveBelow')::int, 0) * 100)),
                   '{manualReviewAbove}',
                     to_jsonb(COALESCE((value->>'manualReviewAbove')::int, 0) * 100))
   WHERE key = 'refund_policy';

  INSERT INTO platform_settings (key, value, "updatedAt")
  VALUES ('money_unit_paise', '{"applied":true}', NOW());

  RAISE NOTICE 'money_to_paise applied';
END $$;
