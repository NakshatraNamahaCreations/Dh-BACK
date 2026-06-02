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
  const gstAmount = Math.round((total * GST_PCT) / 100);
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

exports.GST_PCT = GST_PCT;
exports.PLATFORM_FEE_PCT = PLATFORM_FEE_PCT;
