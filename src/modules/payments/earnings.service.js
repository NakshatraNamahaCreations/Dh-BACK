const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const commissionsService = require('./commissions.service');

/**
 * Partner earnings — the ledger of "money earned per booking" that
 * later rolls up into Payouts.
 *
 * Two integration points:
 *   creditForBooking() — called from bookings.service when a partner
 *     marks a job COMPLETED. Snapshots the booking total and the
 *     category's commission % so a later admin edit doesn't rewrite
 *     historical pay.
 *   listForPartner() / summaryForPartner() — admin views and partner
 *     "my earnings" feeds.
 *
 * Idempotency: `partner_earnings.bookingId` has a UNIQUE constraint,
 * so a second creditForBooking() call for the same booking is a
 * no-op (the catch returns the existing row instead of throwing).
 */

/// Determine the booking's primary category for commission lookup.
/// Multi-category carts are rare (and dispatch already handles them
/// by broadcasting to multiple partner pools); for the earning side
/// we use the FIRST item's category. If the booking has zero items
/// (shouldn't happen, but defensive) we fall back to the default %.
const resolveCategoryId = (booking) => {
  const first = booking.items?.[0];
  return first?.service?.categoryId ?? null;
};

const computeEarning = (bookingTotal, partnerPct) => {
  /// Whole-rupee math, no floats. `Math.round` would be safer for
  /// non-multiples of 100 but `Math.floor` matches the standard
  /// payout-rounding direction (partner gets at most their fair share
  /// — never more than the rule says).
  return Math.floor((Number(bookingTotal) * Number(partnerPct)) / 100);
};

exports.creditForBooking = async (bookingId) => {
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    include: {
      items: { include: { service: { select: { categoryId: true } } } },
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.partnerId == null) {
    throw ApiError.badRequest('Booking has no partner — cannot credit earning');
  }

  const categoryId = resolveCategoryId(booking);
  const partnerPct = await commissionsService.getEffectivePctForCategory(categoryId);
  const earnedAmount = computeEarning(booking.total, partnerPct);

  /// Upsert by bookingId so idempotency is enforced at the DB level.
  /// On the second call we return the existing row instead of bumping
  /// the partner's earnings double.
  const existing = await prisma.partnerEarning.findUnique({
    where: { bookingId: booking.id },
    select: { id: true },
  });
  const earning = await prisma.partnerEarning.upsert({
    where: { bookingId: booking.id },
    create: {
      partnerId: booking.partnerId,
      bookingId: booking.id,
      bookingAmount: booking.total,
      commissionPct: partnerPct,
      earnedAmount,
      status: 'pending',
    },
    update: {}, // no-op on duplicate calls
  });

  /// First-time credit only — re-runs of this method (network retry,
  /// admin re-mark) should NOT spam the partner with duplicate
  /// "Job completed" notifications. The existing-check above is the
  /// idempotency gate.
  if (!existing) {
    const notifications = require('../notifications/notifications.service');
    await notifications.create({
      partnerId: booking.partnerId,
      type: 'job_completed',
      title: 'Job completed',
      body: `₹${earnedAmount} added to your earnings · Booking #${booking.id}`,
      bookingId: booking.id,
    });
  }

  return earning;
};

/// Reverse an earning — used when admin cancels / disputes a
/// completed booking. Idempotent: re-running on an already-reversed
/// row is a no-op. Refuses to reverse rows that have already rolled
/// into a Payout (those need the Payout to be reversed first to
/// keep totals consistent).
exports.reverseForBooking = async (bookingId) => {
  const earning = await prisma.partnerEarning.findUnique({
    where: { bookingId: Number(bookingId) },
  });
  if (!earning) return null;
  if (earning.status === 'reversed') return earning;
  if (earning.status === 'paid' || earning.payoutId != null) {
    throw ApiError.conflict(
      'This earning has already been paid out. Reverse the payout first.',
    );
  }
  return prisma.partnerEarning.update({
    where: { id: earning.id },
    data: { status: 'reversed' },
  });
};

/// Read APIs ---------------------------------------------------------

const earningShape = (e) => ({
  id: e.id,
  partnerId: e.partnerId,
  bookingId: e.bookingId,
  bookingAmount: e.bookingAmount,
  commissionPct: e.commissionPct,
  earnedAmount: e.earnedAmount,
  status: e.status,
  payoutId: e.payoutId,
  createdAt: e.createdAt,
  paidAt: e.paidAt,
  /// Joined fields when the caller asked for booking detail — handy
  /// in the admin drill-down so the table can show what was earned.
  booking: e.booking
    ? {
        id: e.booking.id,
        total: e.booking.total,
        scheduledAt: e.booking.scheduledAt,
        completedAt: e.booking.jobCompletedAt,
        slotLabel: e.booking.slotLabel,
        customer: e.booking.customer?.name ?? null,
      }
    : undefined,
});

exports.listForPartner = async ({ partnerId, status, from, to, page = 1, pageSize = 50 }) => {
  const where = { partnerId: Number(partnerId) };
  if (status && status !== 'all') where.status = status;
  if (from) where.createdAt = { ...(where.createdAt ?? {}), gte: new Date(from) };
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    where.createdAt = { ...(where.createdAt ?? {}), lte: end };
  }

  const [items, total] = await Promise.all([
    prisma.partnerEarning.findMany({
      where,
      include: {
        booking: {
          select: {
            id: true,
            total: true,
            scheduledAt: true,
            jobCompletedAt: true,
            slotLabel: true,
            customer: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.partnerEarning.count({ where }),
  ]);

  return {
    data: items.map(earningShape),
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
};

/// Aggregated summary for the partner's earning headline + chart on
/// the admin drill-in. Three buckets: pending (not yet paid),
/// thisWeek (last 7 days), thisMonth (current calendar month).
exports.summaryForPartner = async (partnerId) => {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 6);
  weekStart.setHours(0, 0, 0, 0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [pending, thisWeek, thisMonth, lifetime] = await Promise.all([
    prisma.partnerEarning.aggregate({
      where: { partnerId: Number(partnerId), status: 'pending' },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.aggregate({
      where: {
        partnerId: Number(partnerId),
        createdAt: { gte: weekStart },
      },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.aggregate({
      where: {
        partnerId: Number(partnerId),
        createdAt: { gte: monthStart },
      },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.aggregate({
      where: { partnerId: Number(partnerId) },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    pending: { amount: pending._sum.earnedAmount ?? 0, count: pending._count._all },
    thisWeek: { amount: thisWeek._sum.earnedAmount ?? 0, count: thisWeek._count._all },
    thisMonth: { amount: thisMonth._sum.earnedAmount ?? 0, count: thisMonth._count._all },
    lifetime: { amount: lifetime._sum.earnedAmount ?? 0, count: lifetime._count._all },
  };
};

/// Admin overview — list of partners with their pending-earning rollup.
/// Drives the main "Payout management" table. Pagination lives over
/// the partner set so the page stays bounded even when the platform
/// has thousands of partners.
exports.listPartnerSummaries = async ({ search, scope, page = 1, pageSize = 25 } = {}) => {
  const { applyScopeToWhere } = require('../../middlewares/adminScope');
  const where = { isActive: true };
  if (search) {
    const s = String(search).trim();
    where.OR = [
      { name: { contains: s, mode: 'insensitive' } },
      { phone: { contains: s, mode: 'insensitive' } },
      { businessName: { contains: s, mode: 'insensitive' } },
    ];
    if (/^\d+$/.test(s)) where.OR.push({ id: Number(s) });
  }
  if (scope) applyScopeToWhere(where, scope);

  const [partners, total] = await Promise.all([
    prisma.partner.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        name: true,
        businessName: true,
        phone: true,
        categoryId: true,
        city: true,
        cityRef: { select: { name: true, state: { select: { name: true, code: true } } } },
      },
    }),
    prisma.partner.count({ where }),
  ]);

  if (partners.length === 0) {
    return { data: [], meta: { page, pageSize, total, totalPages: 1 } };
  }

  const partnerIds = partners.map((p) => p.id);

  /// Single grouped aggregate per metric — far cheaper than running
  /// the three queries above per-partner.
  const [pending, lifetime, lastPaid] = await Promise.all([
    prisma.partnerEarning.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds }, status: 'pending' },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds } },
      _sum: { earnedAmount: true },
      _count: { _all: true },
    }),
    prisma.payout.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds }, status: 'paid' },
      _max: { paidAt: true },
    }),
  ]);

  const pendingByPid = new Map(pending.map((r) => [r.partnerId, r]));
  const lifetimeByPid = new Map(lifetime.map((r) => [r.partnerId, r]));
  const lastPaidByPid = new Map(lastPaid.map((r) => [r.partnerId, r]));

  const data = partners.map((p) => {
    const pe = pendingByPid.get(p.id);
    const lt = lifetimeByPid.get(p.id);
    const lp = lastPaidByPid.get(p.id);
    return {
      partnerId: p.id,
      partner: p.name ?? p.businessName ?? `Partner ${p.id}`,
      phone: p.phone,
      categoryId: p.categoryId,
      city: p.cityRef?.name ?? p.city ?? null,
      state: p.cityRef?.state?.name ?? null,
      stateCode: p.cityRef?.state?.code ?? null,
      pendingAmount: pe?._sum.earnedAmount ?? 0,
      pendingJobs: pe?._count._all ?? 0,
      lifetimeAmount: lt?._sum.earnedAmount ?? 0,
      lifetimeJobs: lt?._count._all ?? 0,
      lastPaidAt: lp?._max.paidAt ?? null,
    };
  });

  return {
    data,
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};
