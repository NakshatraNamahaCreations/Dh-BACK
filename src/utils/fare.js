/**
 * Fare breakdown — single source of truth for how a booking's
 * customer-facing price decomposes into partner share + GST + platform
 * fee.
 *
 * **Pricing model is INCLUSIVE.** The price the customer sees in the
 * cart (and the BYOP offer) IS what they pay end-to-end. GST and the
 * platform fee are extracted *from* that amount — they're NOT added on
 * top. So for a ₹1,699 offer, the customer pays exactly ₹1,699, and
 * GST + platform fee + partner base ADD UP TO ₹1,699.
 *
 * Splits, given a cart-value V (customer-facing total):
 *
 *   grandTotal  — exactly V. What Razorpay charges. What the customer
 *                 sees on the bill.
 *   total       — partner-facing taxable base = V / (1 + GST% + Fee%).
 *                 With 18% + 2% this is V / 1.20. Earnings + commission
 *                 compute on this.
 *   gstAmount   — 18% of `total`.
 *   platformFee — V − total − gstAmount. We balance the rounding gap
 *                 onto this line so the three pieces add to V exactly
 *                 (otherwise rupee rounding can leave a ±₹1 gap visible
 *                 in the UI).
 *
 * Snapshotted onto the Booking row at create time so changes to the
 * percentages later don't rewrite historical splits.
 */

const GST_PCT = 18;
const PLATFORM_FEE_PCT = 2;
const TAX_DIVISOR = 1 + GST_PCT / 100 + PLATFORM_FEE_PCT / 100; // 1.20

exports.computeFare = ({ subtotal, discount = 0, offeredPrice = null } = {}) => {
  const subTotalSafe = Math.max(0, Number(subtotal) || 0);
  const discountSafe = Math.max(0, Number(discount) || 0);
  const offered = offeredPrice == null ? null : Math.max(0, Number(offeredPrice) || 0);

  /// `grandTotal` is the customer's all-in price — sticker minus
  /// coupon, or the BYOP offered amount. Razorpay charges this.
  const grandTotal = offered != null ? offered : Math.max(0, subTotalSafe - discountSafe);

  /// Reverse-derive the partner-facing taxable base from `grandTotal`.
  const total = Math.round(grandTotal / TAX_DIVISOR);
  /// GST is 18% of the base, EXCEPT where rounding would make the parts
  /// exceed the whole. On small amounts `Math.round` nudges the base up:
  /// ₹3 gave total=round(2.54)=3 and gst=1, i.e. 3+1=4 against a ₹3
  /// grandTotal. The platform-fee balancer below is clamped at 0, so it
  /// could not absorb that negative and the invariant
  /// `total + gst + fee === grandTotal` broke silently — reports then
  /// showed GMV ₹63 + GST ₹12 against ₹74 actually collected.
  ///
  /// Clamping GST to the remaining amount fixes exactly that case and
  /// leaves every already-correct split untouched (₹50 stays 42/8/0,
  /// ₹20 stays 17/3/0) — unlike flooring the base, which would shift
  /// those and under-report GST.
  const gstAmount = Math.min(
    Math.round((total * GST_PCT) / 100),
    Math.max(0, grandTotal - total),
  );
  /// Balance the rounding remainder onto platform fee so the three
  /// rupee values reconcile back to `grandTotal` exactly. Without
  /// this you can show "₹417 + ₹75 + ₹8 = ₹500" or off by a rupee
  /// depending on roundings.
  const platformFee = Math.max(0, grandTotal - total - gstAmount);

  return {
    subtotal: subTotalSafe,
    discount: discountSafe,
    offeredPrice: offered,
    total,
    gstAmount,
    platformFee,
    grandTotal,
    /// Echo percentages so the UI labels don't have to hard-code them.
    gstPct: GST_PCT,
    platformFeePct: PLATFORM_FEE_PCT,
  };
};

/**
 * The amount a PARTNER's earnings are computed on.
 *
 * A coupon is a DHOOND-FUNDED promotion, not a price cut on the
 * partner's work: the partner does the same ₹569 job whether or not the
 * customer had a code, so the platform — which chose to run the promo —
 * absorbs it. The coupon is therefore ADDED BACK on top of what the
 * customer actually paid.
 *
 * Worked example (the case this was written for): a ₹569 service with a
 * ₹568 coupon leaves the customer paying ₹1. Splitting that ₹1 credited
 * the partner ₹0.80 — which floors to ₹0 in the whole-rupee ledger — for
 * a full job. The base is now ₹1 + ₹568 = ₹569, so the partner is paid
 * as if no coupon existed and Dhoond carries the ₹568.
 *
 * PAID add-ons join the base (the customer settled that money for this
 * job too); unpaid ones stay out.
 *
 * NOT double-counted on BYOP: the customer app never forwards a coupon
 * alongside an `offeredPrice` (a coupon has no effect on a
 * customer-named price), so `couponDiscount` is null on those rows.
 *
 * Accounting note: this deliberately splits the PRE-coupon value, so a
 * couponed booking records Dhoond's nominal commission (20% of ₹569 =
 * ₹113.80) even though only ₹1 was collected. The ₹568 gap is the
 * marketing spend, tracked on the booking's own `couponDiscount`.
 */
exports.partnerEarningsBase = ({
  grandTotal = 0,
  couponDiscount = 0,
  addOnPaidTotal = 0,
} = {}) =>
  Math.max(0, Number(grandTotal) || 0) +
  Math.max(0, Number(couponDiscount) || 0) +
  Math.max(0, Number(addOnPaidTotal) || 0);

exports.GST_PCT = GST_PCT;
exports.PLATFORM_FEE_PCT = PLATFORM_FEE_PCT;
