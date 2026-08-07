const prisma = require('../../config/prisma');

/**
 * Legacy ledger view — computed on the fly from booking + payment
 * history. Commission and payout logic moved to dedicated services
 * (see commissions.service / earnings.service / payouts.service);
 * this file is now just the ledger feed for the admin Transaction
 * Ledger page.
 *
 * Three event types per booking:
 *   payment    — customer paid
 *   refund     — booking cancelled, money returned
 *   commission — booking completed, platform took its cut
 *
 * Replace with a real `LedgerEntry` table when the analytics team
 * needs queryable history. For now the on-the-fly synthesis is fine
 * — it's bounded by the most recent 200 bookings per request.
 */

exports.listLedger = async ({ type, search, from, to, scope, page = 1, pageSize = 50 } = {}) => {
  const { applyScopeToWhere } = require('../../middlewares/adminScope');
  const where = {};
  if (from) where.createdAt = { ...(where.createdAt ?? {}), gte: new Date(from) };
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    where.createdAt = { ...(where.createdAt ?? {}), lte: end };
  }
  if (scope) applyScopeToWhere(where, scope);

  const bookings = await prisma.booking.findMany({
    where,
    include: {
      customer: { select: { name: true, phone: true } },
      cityRef: { select: { name: true, state: { select: { name: true, code: true } } } },
      /// Joined address — FK-first read so the ledger doesn't show
      /// "null" for cities on new bookings (which no longer write
      /// the snapshot `city` column).
      customerAddress: { select: { city: true } },
      /// Payment audit rows — the ledger surfaces the Razorpay payment id
      /// (cross-reference into the provider dashboard) and the REAL refund
      /// date (`refundedAt`), neither of which live on the booking rollup.
      payments: {
        select: {
          status: true,
          purpose: true,
          providerPaymentId: true,
          paidAt: true,
          refundedAt: true,
          refundAmount: true,
        },
        orderBy: { id: 'desc' },
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  const entries = [];
  /// Running balance starts at zero — every payment / refund /
  /// commission walks from there. Earlier scaffolding seeded a fake
  /// ₹10L float; replaced because there's no real platform-balance
  /// row in the DB to anchor that to, and a synthetic opening
  /// balance was confusing admins (it looked like the platform
  /// had ten lakh rupees of float that doesn't exist).
  let balance = 0;
  for (const b of bookings) {
    const customerName = b.customer?.name ?? 'Customer';
    const customerPhone = b.customer?.phone ?? null;
    const city = b.cityRef?.name ?? b.customerAddress?.city ?? b.city ?? null;
    const state = b.cityRef?.state?.name ?? null;

    /// Ledger entries mirror MONEY MOVEMENT, not booking lifecycle.
    /// A booking with no settled payment contributes nothing: an unpaid
    /// PENDING row is not income, and an unpaid CANCELLED row (abandoned
    /// checkout, no-pay timeout) must NOT mint a "Cancellation refund" —
    /// that showed money flowing out that never came in and walked the
    /// running balance negative.
    const moneyIn = ['paid', 'refund_pending', 'refunded'].includes(b.paymentStatus);
    if (!moneyIn) continue;

    /// The settled booking-payment audit row (most recent first). Free
    /// coupon-settled bookings carry a 'coupon' purpose row with no
    /// provider id — the ledger just shows a blank id for those.
    const settledPay =
      (b.payments ?? []).find(
        (p) =>
          ['paid', 'refund_pending', 'refunded'].includes(p.status) &&
          ['booking', 'coupon'].includes(p.purpose),
      ) ?? null;

    balance += b.total;
    entries.push({
      id: `TX-P-${b.id}`,
      timestamp: (b.paidAt ?? settledPay?.paidAt ?? b.createdAt).toISOString(),
      type: 'payment',
      description: 'Customer payment received',
      reference: b.id,
      party: customerName,
      partyPhone: customerPhone,
      city,
      state,
      providerPaymentId: settledPay?.providerPaymentId ?? null,
      debit: 0,
      credit: b.total,
      balance,
    });

    if (b.status === 'CANCELLED') {
      /// Refund entry only when a refund is actually in flight or done
      /// (refund status, or an explicit refundAmount recorded by the
      /// cancellation flow). Cancelled-but-paid rows awaiting a refund
      /// decision show just the payment until the refund really moves.
      const refundOut =
        ['refund_pending', 'refunded'].includes(b.paymentStatus) ||
        settledPay?.refundAmount != null;
      if (refundOut) {
        const refundAmt = settledPay?.refundAmount ?? b.total;
        balance -= refundAmt;
        entries.push({
          id: `TX-R-${b.id}`,
          /// Real refund moment when the provider confirmed it
          /// (payments.refundedAt); cancellation time as the fallback
          /// while the refund is still pending.
          timestamp: (settledPay?.refundedAt ?? b.updatedAt).toISOString(),
          type: 'refund',
          description: 'Cancellation refund',
          /// Explicit copy of the payments-table refund moment (the
          /// `timestamp` above is the same value when it's set) — null
          /// while a refund is still pending provider confirmation.
          refundedAt: settledPay?.refundedAt?.toISOString() ?? null,
          reference: b.id,
          party: customerName,
          partyPhone: customerPhone,
          city,
          state,
          providerPaymentId: settledPay?.providerPaymentId ?? null,
          debit: refundAmt,
          credit: 0,
          balance,
        });
      }
    } else if (b.status === 'COMPLETED') {
      const comm = Math.round(b.total * 0.18);
      balance -= comm;
      entries.push({
        id: `TX-C-${b.id}`,
        timestamp: b.updatedAt.toISOString(),
        type: 'commission',
        description: 'Platform commission · 18%',
        reference: b.id,
        party: customerName,
        partyPhone: customerPhone,
        city,
        state,
        providerPaymentId: null,
        debit: comm,
        credit: 0,
        balance,
      });
    }
  }

  // Apply filters.
  let filtered = entries;
  if (type && type !== 'all') filtered = filtered.filter((e) => e.type === type);
  if (search) {
    const s = search.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.id.toLowerCase().includes(s) ||
        /// reference is the numeric booking id — String() it (calling
        /// .toLowerCase() directly on a number throws).
        String(e.reference).toLowerCase().includes(s) ||
        e.party.toLowerCase().includes(s) ||
        e.description.toLowerCase().includes(s) ||
        (e.providerPaymentId ?? '').toLowerCase().includes(s),
    );
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return {
    data: filtered.slice(start, start + pageSize),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};
