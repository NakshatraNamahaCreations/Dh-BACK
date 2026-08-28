-- ============================================================================
-- REVERT: PAISE → RUPEES
--
-- Undoes 20260828120000_money_to_paise and its fixup, at the user's request.
-- Every money column goes back to whole rupees.
--
-- Consequence, stated plainly: whole-rupee storage cannot hold the agreed
-- settlement precision. A ₹499 job credits the partner ₹379 again instead of
-- ₹379.24, and that fraction is lost on every booking.
--
-- Derived booking fields (total / gstAmount / platformFee) are RECOMPUTED
-- from the rupee grandTotal rather than divided, because dividing them
-- independently breaks the invariant total + gst + fee = grandTotal on any
-- amount that isn't a clean multiple of 100.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_settings WHERE key = 'money_unit_paise') THEN
    RAISE NOTICE 'not in paise — nothing to revert';
    RETURN;
  END IF;

  UPDATE partners        SET "onboardingFeeAmount" = ROUND("onboardingFeeAmount" / 100.0)
                         WHERE "onboardingFeeAmount" IS NOT NULL;

  UPDATE services        SET "basePrice" = ROUND("basePrice" / 100.0);
  UPDATE services        SET "originalPrice" = ROUND("originalPrice" / 100.0)
                         WHERE "originalPrice" IS NOT NULL;
  UPDATE booking_items   SET "basePrice" = ROUND("basePrice" / 100.0);
  UPDATE booking_add_ons SET "price"     = ROUND("price" / 100.0);

  -- Stored amounts first; derived fare fields are rebuilt below.
  UPDATE bookings SET
    "subtotal"       = ROUND("subtotal" / 100.0),
    "discount"       = ROUND("discount" / 100.0),
    "grandTotal"     = ROUND("grandTotal" / 100.0),
    "couponDiscount" = ROUND("couponDiscount" / 100.0),
    "offeredPrice"   = ROUND("offeredPrice" / 100.0);

  -- Rebuild total / GST / platform fee so the breakdown still reconciles.
  -- Mirrors utils/fare.js: base = grandTotal / 1.20, GST clamped to what is
  -- actually left, platform fee takes the remainder.
  UPDATE bookings b SET
    "total"       = d.base,
    "gstAmount"   = d.gst,
    "platformFee" = GREATEST(0, b."grandTotal" - d.base - d.gst)
  FROM (
    SELECT
      id,
      ROUND("grandTotal" / 1.20)::int AS base,
      LEAST(
        ROUND(ROUND("grandTotal" / 1.20) * 0.18)::int,
        GREATEST(0, "grandTotal" - ROUND("grandTotal" / 1.20)::int)
      ) AS gst
    FROM bookings
  ) d
  WHERE b.id = d.id;

  UPDATE payments SET
    "amount"       = ROUND("amount" / 100.0),
    "refundAmount" = ROUND("refundAmount" / 100.0);

  UPDATE partner_earnings SET
    "bookingAmount"    = ROUND("bookingAmount" / 100.0),
    "earnedAmount"     = ROUND("earnedAmount" / 100.0),
    "dhoondCommission" = ROUND("dhoondCommission" / 100.0),
    "dhoondGst"        = ROUND("dhoondGst" / 100.0),
    "dhoondNet"        = ROUND("dhoondNet" / 100.0),
    "partnerGst"       = ROUND("partnerGst" / 100.0),
    "netAmount"        = ROUND("netAmount" / 100.0);

  UPDATE payouts             SET "amount" = ROUND("amount" / 100.0);
  UPDATE partner_adjustments SET "amount" = ROUND("amount" / 100.0);

  -- Only FLAT coupons were scaled; PERCENT holds a percentage.
  UPDATE coupons SET "discountValue" = ROUND("discountValue" / 100.0) WHERE "discountType" = 'FLAT';
  UPDATE coupons SET "minOrderValue" = ROUND("minOrderValue" / 100.0);
  UPDATE coupons SET "maxDiscount"   = ROUND("maxDiscount" / 100.0) WHERE "maxDiscount" IS NOT NULL;

  UPDATE platform_settings
     SET value = jsonb_set(value, '{partnerPenalty}',
                 to_jsonb(ROUND(COALESCE((value->>'partnerPenalty')::numeric, 0) / 100.0)::int))
   WHERE key = 'cancellation_policy' AND value->>'partnerPenalty' IS NOT NULL;

  UPDATE platform_settings
     SET value = jsonb_set(
                   jsonb_set(value, '{autoApproveBelow}',
                     to_jsonb(ROUND(COALESCE((value->>'autoApproveBelow')::numeric, 0) / 100.0)::int)),
                   '{manualReviewAbove}',
                     to_jsonb(ROUND(COALESCE((value->>'manualReviewAbove')::numeric, 0) / 100.0)::int))
   WHERE key = 'refund_policy';

  DELETE FROM platform_settings WHERE key IN ('money_unit_paise', 'money_unit_paise_fixup');

  RAISE NOTICE 'reverted to rupees';
END $$;
