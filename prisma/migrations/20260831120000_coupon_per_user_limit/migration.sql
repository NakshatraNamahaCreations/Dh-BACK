-- Per-customer usage cap for coupons, distinct from the existing
-- platform-wide `usageLimit`. Null = unlimited per customer, which
-- keeps every existing coupon row behaving exactly as before.
ALTER TABLE "coupons" ADD COLUMN "perUserLimit" INTEGER;
