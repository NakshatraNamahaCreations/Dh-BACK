/**
 * Percentage splits that always add up.
 *
 * Money is stored in whole rupees. Splitting an amount between the partner
 * and Dhoond by flooring BOTH sides independently loses the odd unit — a ₹1
 * booking paid neither party (floor(0.8) = 0 and floor(0.2) = 0), and even a
 * ₹499 job lost a rupee (399 + 99 = 498).
 *
 * Returning [share, remainder] instead guarantees the two halves sum back to
 * the input, whatever the percentage.
 */

/// Split `amount` by `pct`, as [share, remainder]. share + remainder === amount.
const splitByPct = (amount, pct) => {
  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const p = Number(pct) || 0;
  const share = Math.floor((amt * p) / 100);
  return [share, amt - share];
};

module.exports = { splitByPct };
