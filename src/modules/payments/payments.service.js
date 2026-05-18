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
    const city = b.cityRef?.name ?? b.customerAddress?.city ?? b.city ?? null;
    const state = b.cityRef?.state?.name ?? null;
    if (b.status === 'CANCELLED') {
      balance -= b.total;
      entries.push({
        id: `TX-R-${b.id}`,
        timestamp: b.updatedAt.toISOString(),
        type: 'refund',
        description: 'Cancellation refund',
        reference: b.id,
        party: customerName,
        city,
        state,
        debit: b.total,
        credit: 0,
        balance,
      });
    } else {
      balance += b.total;
      entries.push({
        id: `TX-P-${b.id}`,
        timestamp: b.createdAt.toISOString(),
        type: 'payment',
        description: 'Customer payment received',
        reference: b.id,
        party: customerName,
        city,
        state,
        debit: 0,
        credit: b.total,
        balance,
      });
      if (b.status === 'COMPLETED') {
        const comm = Math.round(b.total * 0.18);
        balance -= comm;
        entries.push({
          id: `TX-C-${b.id}`,
          timestamp: b.updatedAt.toISOString(),
          type: 'commission',
          description: 'Platform commission · 18%',
          reference: b.id,
          party: customerName,
          city,
          state,
          debit: comm,
          credit: 0,
          balance,
        });
      }
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
        e.reference.toLowerCase().includes(s) ||
        e.party.toLowerCase().includes(s) ||
        e.description.toLowerCase().includes(s),
    );
  }

  const total = filtered.length;
  const start = (page - 1) * pageSize;
  return {
    data: filtered.slice(start, start + pageSize),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};
