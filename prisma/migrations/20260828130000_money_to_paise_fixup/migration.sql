-- ============================================================================
-- MONEY → PAISE, FIXUP
--
-- The main migration (20260828120000_money_to_paise) missed two money
-- columns:
--
--   services.originalPrice   — the struck-through MRP. Had data (105 rows),
--                              so it was left showing 1/100th of its value
--                              next to a correctly-converted basePrice.
--   bookings.couponDiscount  — no rows at the time, but the column is money
--                              and is handled here so the pair of migrations
--                              is complete.
--
-- Guarded separately from the main migration, which had already written its
-- own marker by the time this gap was found.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_settings WHERE key = 'money_unit_paise_fixup') THEN
    RAISE NOTICE 'money_to_paise_fixup already applied — skipping';
    RETURN;
  END IF;

  UPDATE services SET "originalPrice" = "originalPrice" * 100
   WHERE "originalPrice" IS NOT NULL;

  UPDATE bookings SET "couponDiscount" = "couponDiscount" * 100
   WHERE "couponDiscount" IS NOT NULL;

  INSERT INTO platform_settings (key, value, "updatedAt")
  VALUES ('money_unit_paise_fixup', '{"applied":true}', NOW());

  RAISE NOTICE 'money_to_paise_fixup applied';
END $$;
