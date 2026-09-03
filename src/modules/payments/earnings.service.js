const prisma = require('../../config/prisma');
const { splitByPct } = require('../../utils/split');
const { partnerEarningsBase } = require('../../utils/fare');
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

/// Full breakdown per the business design:
///
///   bookingAmount × partnerPct%     → partner GROSS (earnedAmount)
///   partner gross × 5%              → partner GST (CGST 2.5% + SGST 2.5%)
///   partner gross − partner GST     → netAmount (actually credited to partner)
///
///   bookingAmount × (100−partnerPct)% → Dhoond commission
///   Dhoond commission × 18%           → Dhoond GST (CGST 9% + SGST 9%)
///   Dhoond commission − Dhoond GST    → dhoondNet
///
/// All values are Int (whole rupees), using Math.floor to avoid
/// ever crediting more than the rule authorises.
/// Commission base = grandTotal (the customer-facing all-in price).
/// Split:
///   partner gross  = grandTotal × partnerPct%         (e.g. 80% of ₹499 = ₹399.2)
///   partner 5% GST = partner gross × 5%               (e.g. 5%  of ₹399 = ₹19.96)
///   partner net    = partner gross − partner GST       (e.g. ₹399 − ₹20 = ₹379  ← credited)
///   dhoond gross   = grandTotal × (100−partnerPct)%   (e.g. 20% of ₹499 = ₹99.8)
///   dhoond 18% GST = dhoond gross × 18%               (e.g. 18% of ₹99 = ₹17.96)
///   dhoond net     = dhoond gross − dhoond GST        (e.g. ₹99 − ₹18 = ₹81)
const computeBreakdown = (bookingAmount, partnerPct) => {
  /// `splitByPct` returns [share, remainder] so the two ALWAYS sum back to
  /// the input. Flooring both sides independently dropped the odd unit —
  /// that bug paid neither party on a ₹1 booking, and lost a rupee even on
  /// the ₹499 example (399 + 99 = 498).
  const [earnedAmount, dhoondCommission] = splitByPct(bookingAmount, partnerPct);

  // Math.round so 19.95 → 20 (matches the 5% of 399.2 = 19.96 design)
  const partnerGst = Math.round(earnedAmount * 5  / 100);
  const dhoondGst  = Math.round(dhoondCommission * 18 / 100);

  return {
    earnedAmount,                          // partner gross (before 5% GST)
    dhoondCommission,
    dhoondGst,
    dhoondNet:  dhoondCommission - dhoondGst,
    partnerGst,
    netAmount:  earnedAmount - partnerGst, // credited to partner
  };
};

/// Two-decimal DISPLAY split, recomputed from the earning row's
/// snapshotted inputs (bookingAmount × commissionPct) — the SAME math the
/// admin Booking report uses. The persisted Int columns are the credited
/// LEDGER (floored whole rupees, so we never credit more than authorised);
/// on a small booking they read ₹0 — 80% of ₹1 floors to 0 — which made
/// the payout page show ₹0 payable while the Booking report showed the
/// same booking crediting ₹0.76. The report reads below aggregate THIS
/// split for display; ledger writes (creditForBooking / weeklyMarkPaid /
/// payout records) stay on the Int columns.
const money2 = (v) => Math.round(v * 100) / 100;
const displaySplit = (e) => {
  const base = e.bookingAmount ?? 0;
  const pct = e.commissionPct ?? 80;
  const partnerGross = money2((base * pct) / 100);
  const dhoondGross = money2(base - partnerGross);
  const partnerGst = money2((partnerGross * 5) / 100);
  const dhoondGst = money2((dhoondGross * 18) / 100);
  return {
    partnerGross,
    partnerGst,
    partnerNet: money2(partnerGross - partnerGst),
    dhoondGross,
    dhoondGst,
    dhoondNet: money2(dhoondGross - dhoondGst),
  };
};

exports.creditForBooking = async (bookingId) => {
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    include: {
      items: { include: { service: { select: { categoryId: true } } } },
      addOns: { select: { price: true, qty: true, status: true } },
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.partnerId == null) {
    throw ApiError.badRequest('Booking has no partner — cannot credit earning');
  }

  const categoryId = resolveCategoryId(booking);
  const partnerPct = await commissionsService.getEffectivePctForCategory(categoryId);
  // Base = grandTotal (the all-in price) + PAID add-ons + any COUPON the
  // customer redeemed. The coupon is added back because Dhoond funds the
  // promotion, not the partner — see `partnerEarningsBase`. Without it a
  // ₹569 job bought with a ₹568 coupon credited the partner ₹0.
  // The partner earns their % of this, then 5% GST comes off their share.
  const addOnPaidTotal = (booking.addOns ?? [])
    .filter((a) => a.status === 'paid')
    .reduce((s, a) => s + a.price * a.qty, 0);
  const base = partnerEarningsBase({
    grandTotal: booking.grandTotal ?? booking.total,
    couponDiscount: booking.couponDiscount,
    addOnPaidTotal,
  });
  const bd = computeBreakdown(base, partnerPct);

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
      partnerId:        booking.partnerId,
      bookingId:        booking.id,
      /// The amount the split was actually computed on (grandTotal +
      /// paid add-ons). Previously stored `booking.total` — the pre-GST
      /// figure — so a ₹50 booking recorded a ₹42 base while its 80/20
      /// split was taken on ₹50. Same value now, so the row is auditable.
      bookingAmount:    base,
      commissionPct:    partnerPct,
      earnedAmount:     bd.earnedAmount,     // partner gross (before 5% GST)
      dhoondCommission: bd.dhoondCommission,
      dhoondGst:        bd.dhoondGst,
      dhoondNet:        bd.dhoondNet,
      partnerGst:       bd.partnerGst,
      netAmount:        bd.netAmount,        // credited to partner after 5% GST
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
      body: `₹${bd.netAmount} credited to your earnings · Booking #${booking.id}`,
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
  earnedAmount: e.earnedAmount,     // partner gross (before 5% GST)
  // ── Breakdown ────────────────────────────────────────────────────
  breakdown: {
    dhoondCommission: e.dhoondCommission ?? 0,
    dhoondGst:        e.dhoondGst        ?? 0,
    dhoondNet:        e.dhoondNet        ?? 0,
    partnerGst:       e.partnerGst       ?? 0,
    netAmount:        e.netAmount        ?? 0,  // credited to partner
  },
  // ─────────────────────────────────────────────────────────────────
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
      _sum: { earnedAmount: true, netAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.aggregate({
      where: {
        partnerId: Number(partnerId),
        createdAt: { gte: weekStart },
      },
      _sum: { earnedAmount: true, netAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.aggregate({
      where: {
        partnerId: Number(partnerId),
        createdAt: { gte: monthStart },
      },
      _sum: { earnedAmount: true, netAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.aggregate({
      where: { partnerId: Number(partnerId) },
      _sum: { earnedAmount: true, netAmount: true },
      _count: { _all: true },
    }),
  ]);

  return {
    pending: {
      amount: pending._sum.netAmount ?? pending._sum.earnedAmount ?? 0,
      grossAmount: pending._sum.earnedAmount ?? 0,
      count: pending._count._all,
    },
    thisWeek: {
      amount: thisWeek._sum.netAmount ?? thisWeek._sum.earnedAmount ?? 0,
      grossAmount: thisWeek._sum.earnedAmount ?? 0,
      count: thisWeek._count._all,
    },
    thisMonth: {
      amount: thisMonth._sum.netAmount ?? thisMonth._sum.earnedAmount ?? 0,
      grossAmount: thisMonth._sum.earnedAmount ?? 0,
      count: thisMonth._count._all,
    },
    lifetime: {
      amount: lifetime._sum.netAmount ?? lifetime._sum.earnedAmount ?? 0,
      grossAmount: lifetime._sum.earnedAmount ?? 0,
      count: lifetime._count._all,
    },
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

  /// Earning rows fetched once for the page's partners and aggregated in
  /// JS with the exact 2dp split (Booking-report math) — a DB groupBy
  /// over the floored Int netAmount showed ₹0 pending on small bookings
  /// while the Booking report credited the partner.
  const [earnRows, lastPaid, pendingAdj] = await Promise.all([
    prisma.partnerEarning.findMany({
      where: { partnerId: { in: partnerIds } },
      select: { partnerId: true, status: true, bookingAmount: true, commissionPct: true },
    }),
    prisma.payout.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds }, status: 'paid' },
      _max: { paidAt: true },
    }),
    /// Pending debits (cancellation penalties) that will net against the
    /// next payout — subtracted from the displayed pending so the admin
    /// sees the real settle amount, not the gross earnings.
    prisma.partnerAdjustment.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds }, status: 'pending' },
      _sum: { amount: true },
    }),
  ]);

  const pendingByPid = new Map();
  const lifetimeByPid = new Map();
  for (const e of earnRows) {
    const net = displaySplit(e).partnerNet;
    const lt = lifetimeByPid.get(e.partnerId) ?? { amount: 0, count: 0 };
    lt.amount += net;
    lt.count += 1;
    lifetimeByPid.set(e.partnerId, lt);
    if (e.status === 'pending') {
      const pe = pendingByPid.get(e.partnerId) ?? { amount: 0, count: 0 };
      pe.amount += net;
      pe.count += 1;
      pendingByPid.set(e.partnerId, pe);
    }
  }
  const lastPaidByPid = new Map(lastPaid.map((r) => [r.partnerId, r]));
  const pendingAdjByPid = new Map(pendingAdj.map((r) => [r.partnerId, r]));

  const data = partners.map((p) => {
    const pe = pendingByPid.get(p.id);
    const lt = lifetimeByPid.get(p.id);
    const lp = lastPaidByPid.get(p.id);
    const adj = pendingAdjByPid.get(p.id);
    const pendingDeductions = adj?._sum.amount ?? 0;
    return {
      partnerId: p.id,
      partner: p.name ?? p.businessName ?? `Partner ${p.id}`,
      phone: p.phone,
      categoryId: p.categoryId,
      city: p.cityRef?.name ?? p.city ?? null,
      state: p.cityRef?.state?.name ?? null,
      stateCode: p.cityRef?.state?.code ?? null,
      pendingAmount: money2((pe?.amount ?? 0) - pendingDeductions),
      pendingJobs: pe?.count ?? 0,
      /// Surfaced so the payout table can show "−₹X penalties" alongside
      /// the net pending figure.
      pendingDeductions,
      lifetimeAmount: money2(lt?.amount ?? 0),
      lifetimeJobs: lt?.count ?? 0,
      lastPaidAt: lp?._max.paidAt ?? null,
    };
  });

  return {
    data,
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

// ── Weekly settlements (Monday → Sunday) ───────────────────────────────────
// Admin "pay the partners weekly" workflow: aggregate every earning
// credited inside the week per partner (jobs, gross, commission split,
// payable) alongside the partner's bank details, export it as CSV, pay
// through the bank, then bulk-flip the week's earnings to paid.

/// Normalise ANY date inside a week to that week's Monday 00:00 local,
/// returning [monday, nextMonday).
const weekRange = (weekStartStr) => {
  const start = new Date(`${weekStartStr}T00:00:00`);
  if (Number.isNaN(start.getTime())) throw ApiError.badRequest('Invalid weekStart date');
  const day = start.getDay(); // 0 = Sunday … 6 = Saturday
  start.setDate(start.getDate() + (day === 0 ? -6 : 1 - day));
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  return { start, end };
};

/// Prisma WHERE fragment scoping a PartnerEarning query to partners whose
/// HOME CITY falls inside the admin's / the UI's State→City filter.
/// `scope.cityIds === null` (SUPER admin, no filter picked) → no-op.
/// Empty array → forced no-match (`cityId = -1`), same convention as
/// `applyScopeToWhere` in middlewares/adminScope.
const partnerCityWhere = (scope) => {
  if (!scope || scope.cityIds == null) return {};
  const cityFilter =
    scope.cityIds.length === 0
      ? -1
      : scope.cityIds.length === 1
        ? scope.cityIds[0]
        : { in: scope.cityIds };
  return { partner: { cityId: cityFilter } };
};

exports.weeklySettlements = async ({ weekStart, scope }) => {
  const { start, end } = weekRange(weekStart);
  const rows = await prisma.partnerEarning.findMany({
    where: { createdAt: { gte: start, lt: end }, ...partnerCityWhere(scope) },
    include: {
      partner: {
        select: {
          id: true,
          name: true,
          businessName: true,
          phone: true,
          city: true,
          cityRef: { select: { name: true, state: { select: { name: true } } } },
          document: { select: { bankAccount: true, bankIfsc: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const byPartner = new Map();
  for (const e of rows) {
    let agg = byPartner.get(e.partnerId);
    if (!agg) {
      agg = {
        partnerId: e.partnerId,
        name: e.partner?.name ?? e.partner?.businessName ?? `Partner #${e.partnerId}`,
        phone: e.partner?.phone ?? '',
        /// Home-city geography for the admin table's Location column.
        /// cityRef (Geography row) wins; legacy free-text city is the
        /// fallback for rows pre-dating the cityId backfill.
        city: e.partner?.cityRef?.name ?? e.partner?.city ?? null,
        state: e.partner?.cityRef?.state?.name ?? null,
        bankAccount: e.partner?.document?.bankAccount ?? null,
        bankIfsc: e.partner?.document?.bankIfsc ?? null,
        jobs: 0,
        grossAmount: 0,
        commission: 0,
        partnerGross: 0,
        partnerGst: 0,
        payable: 0,
        paidJobs: 0,
      };
      byPartner.set(e.partnerId, agg);
    }
    /// Exact 2dp split (Booking-report math) — NOT the floored Int
    /// ledger columns, which read ₹0 on small bookings.
    const s = displaySplit(e);
    agg.jobs += 1;
    agg.grossAmount += e.bookingAmount;
    agg.commission += s.dhoondGross;
    /// The partner's share BEFORE the 5% GST deduction — shown on the
    /// weekly table so the payable column reads as "gross − GST = net".
    agg.partnerGross += s.partnerGross;
    agg.partnerGst += s.partnerGst;
    /// What actually lands in the partner's bank for the week.
    agg.payable += s.partnerNet;
    if (e.status === 'paid') agg.paidJobs += 1;
  }

  /// This week's still-unpaid net per partner (drives "week pending").
  const weekPendingByPartner = new Map();
  for (const e of rows) {
    if (e.status === 'paid' || e.status === 'reversed') continue;
    weekPendingByPartner.set(
      e.partnerId,
      (weekPendingByPartner.get(e.partnerId) ?? 0) + displaySplit(e).partnerNet,
    );
  }

  /// Carry-forward: unpaid earnings from BEFORE this week — the "last
  /// week(s) pending" the accountant must chase. Aggregated per partner
  /// in JS (not a DB groupBy over the Int netAmount) so old dues use the
  /// same exact split as the week itself; surfaces even when the partner
  /// had no jobs this week.
  const carryEarnings = await prisma.partnerEarning.findMany({
    where: {
      createdAt: { lt: start },
      status: { notIn: ['paid', 'reversed'] },
      ...partnerCityWhere(scope),
    },
    select: { partnerId: true, bookingAmount: true, commissionPct: true },
  });
  const carryByPartner = new Map();
  for (const e of carryEarnings) {
    const c = carryByPartner.get(e.partnerId) ?? { amount: 0, jobs: 0 };
    c.amount += displaySplit(e).partnerNet;
    c.jobs += 1;
    carryByPartner.set(e.partnerId, c);
  }
  const carryRows = [...carryByPartner.entries()].map(([partnerId]) => ({ partnerId }));

  /// Pending debits (cancellation penalties, etc.) — ANY pending
  /// PartnerAdjustment, not scoped to this week, mirroring the classic
  /// Generate-payout flow's netting so the figure shown here is exactly
  /// what "Mark week paid" is about to deduct. Not type-filtered (same
  /// as `generateForPartner` / `listPartnerSummaries`) so a future debit
  /// type nets the same way without a code change.
  const pendingAdjRows = await prisma.partnerAdjustment.groupBy({
    by: ['partnerId'],
    where: { status: 'pending', payoutId: null, ...partnerCityWhere(scope) },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const pendingAdjByPartner = new Map(
    pendingAdjRows.map((a) => [a.partnerId, { amount: a._sum.amount ?? 0, count: a._count._all }]),
  );

  /// Partners with old dues OR pending penalties but NO earnings this
  /// week still need a row (otherwise those amounts silently vanish
  /// from the screen).
  const missingIds = [
    ...new Set([
      ...carryRows.map((c) => c.partnerId).filter((id) => (carryByPartner.get(id)?.amount ?? 0) > 0),
      ...pendingAdjRows.map((a) => a.partnerId).filter((id) => (pendingAdjByPartner.get(id)?.amount ?? 0) !== 0),
    ]),
  ].filter((id) => !byPartner.has(id));
  if (missingIds.length) {
    const partners = await prisma.partner.findMany({
      where: { id: { in: missingIds } },
      select: {
        id: true,
        name: true,
        businessName: true,
        phone: true,
        city: true,
        cityRef: { select: { name: true, state: { select: { name: true } } } },
        document: { select: { bankAccount: true, bankIfsc: true } },
      },
    });
    for (const p of partners) {
      byPartner.set(p.id, {
        partnerId: p.id,
        name: p.name ?? p.businessName ?? `Partner #${p.id}`,
        phone: p.phone ?? '',
        city: p.cityRef?.name ?? p.city ?? null,
        state: p.cityRef?.state?.name ?? null,
        bankAccount: p.document?.bankAccount ?? null,
        bankIfsc: p.document?.bankIfsc ?? null,
        jobs: 0,
        grossAmount: 0,
        commission: 0,
        partnerGross: 0,
        partnerGst: 0,
        payable: 0,
        paidJobs: 0,
      });
    }
  }

  /// Admin remarks for this week ("transfer bounced", "IFSC wrong…") —
  /// one per partner, attached to the aggregated row + the CSV export.
  const notes = await prisma.weeklySettlementNote.findMany({
    where: { weekStart: start },
    select: { partnerId: true, remark: true },
  });
  const remarkByPartner = new Map(notes.map((n) => [n.partnerId, n.remark]));

  const items = [...byPartner.values()]
    .map((a) => {
      const weekPending = money2(weekPendingByPartner.get(a.partnerId) ?? 0);
      const carry = carryByPartner.get(a.partnerId) ?? { amount: 0, jobs: 0 };
      const carryForward = money2(carry.amount);
      const pendingAdj = pendingAdjByPartner.get(a.partnerId) ?? { amount: 0, count: 0 };
      const penalties = money2(pendingAdj.amount);
      return {
        ...a,
        /// money2 on every accumulated figure — pure float-drift guard.
        grossAmount: money2(a.grossAmount),
        commission: money2(a.commission),
        partnerGross: money2(a.partnerGross),
        partnerGst: money2(a.partnerGst),
        payable: money2(a.payable),
        weekPending,
        /// Old dues from previous weeks (still unpaid).
        carryForward,
        carryForwardJobs: carry.jobs,
        /// Pending debits (cancellation penalties) that "Mark week paid"
        /// will net out of the transfer — same figure the classic
        /// Generate-payout flow deducts. Can exceed what's owed (a
        /// partner who cancelled a lot with few completed jobs); the
        /// UI shows that as a negative total due rather than pretending
        /// the debt doesn't exist.
        penalties,
        penaltyCount: pendingAdj.count,
        /// Everything the partner is owed as of this week's end, AFTER
        /// pending penalties. This is the exact amount "Mark week paid"
        /// transfers and settles.
        totalDue: money2(weekPending + carryForward - penalties),
        status:
          a.jobs === 0
            ? 'pending' // carry-forward-only row
            : a.paidJobs === a.jobs
              ? 'paid'
              : a.paidJobs > 0
                ? 'partial'
                : 'pending',
        remark: remarkByPartner.get(a.partnerId) ?? null,
      };
    })
    .sort((x, y) => y.totalDue - x.totalDue || y.payable - x.payable);

  return {
    weekStart: start.toISOString(),
    weekEnd: new Date(end.getTime() - 1).toISOString(),
    totals: {
      partners: items.length,
      jobs: items.reduce((s, a) => s + a.jobs, 0),
      /// Sum of the customer-paid booking totals for the week — the base
      /// the commission/gross/GST columns are split from.
      grossAmount: money2(items.reduce((s, a) => s + a.grossAmount, 0)),
      payable: money2(items.reduce((s, a) => s + a.payable, 0)),
      pendingPayable: money2(items.reduce((s, a) => s + a.weekPending, 0)),
      carryForward: money2(items.reduce((s, a) => s + a.carryForward, 0)),
      penalties: money2(items.reduce((s, a) => s + a.penalties, 0)),
      totalDue: money2(items.reduce((s, a) => s + a.totalDue, 0)),
    },
    items,
  };
};

/// Bulk-settle: flip every not-yet-paid earning UP TO the end of the
/// selected week (i.e. this week's dues + all carry-forward from earlier
/// weeks) to paid — optionally scoped to specific partners (the admin's
/// ticked rows). Matches the real bank transfer, which pays the
/// partner's TOTAL DUE, not just the week slice.
///
/// Each settled partner also gets a Payout record (status "paid") with
/// the covered earnings linked to it — so the settlement shows up in
/// the Payout history tab exactly like the classic generate → approve →
/// mark-paid flow, and the audit trail stays in one place. Idempotent;
/// already-paid rows are untouched.
exports.weeklyMarkPaid = async ({ weekStart, partnerIds, scope }) => {
  const { start, end } = weekRange(weekStart);
  const due = await prisma.partnerEarning.findMany({
    where: {
      createdAt: { lt: end },
      status: { notIn: ['paid', 'reversed'] },
      ...(Array.isArray(partnerIds) && partnerIds.length
        ? { partnerId: { in: partnerIds.map(Number) } }
        : {}),
      /// Geography guard — "Mark week paid" with a State/City filter (or
      /// a CITY_MANAGER's assignment) must only settle partners in scope,
      /// never the whole platform.
      ...partnerCityWhere(scope),
    },
    select: { id: true, partnerId: true, netAmount: true, earnedAmount: true, createdAt: true },
  });
  if (!due.length) return { updated: 0, payouts: 0 };

  const byPartner = new Map();
  for (const e of due) {
    if (!byPartner.has(e.partnerId)) byPartner.set(e.partnerId, []);
    byPartner.get(e.partnerId).push(e);
  }

  /// Pending debits (cancellation penalties, etc.) for every partner
  /// being settled — netted into the payout amount below, exactly like
  /// the classic Generate-payout flow. Previously "Mark week paid" only
  /// looked at PartnerEarning rows, so a partner's cancellation
  /// penalties never actually left their balance: they just sat as
  /// `pending` PartnerAdjustment rows forever while the full earnings
  /// amount got paid out regardless.
  const settledPartnerIds = [...byPartner.keys()];
  const pendingAdjustments = await prisma.partnerAdjustment.findMany({
    where: { partnerId: { in: settledPartnerIds }, status: 'pending', payoutId: null },
    select: { id: true, partnerId: true, amount: true },
  });
  const adjByPartner = new Map();
  for (const a of pendingAdjustments) {
    if (!adjByPartner.has(a.partnerId)) adjByPartner.set(a.partnerId, []);
    adjByPartner.get(a.partnerId).push(a);
  }

  const now = new Date();
  const weekLabel = start.toISOString().slice(0, 10);
  let updated = 0;

  for (const [partnerId, earnings] of byPartner) {
    const earningsTotal = earnings.reduce(
      (s, e) => s + (e.netAmount > 0 ? e.netAmount : e.earnedAmount),
      0,
    );
    const adjustments = adjByPartner.get(partnerId) ?? [];
    const adjustmentsTotal = adjustments.reduce((s, a) => s + a.amount, 0);
    /// Can go negative when pending penalties exceed the week's
    /// earnings — same intentional behaviour as `generateForPartner`
    /// (the partner carries the remaining debit into the next cycle
    /// rather than it silently disappearing).
    const amount = earningsTotal - adjustmentsTotal;
    const periodStart = earnings.reduce(
      (min, e) => (e.createdAt < min ? e.createdAt : min),
      earnings[0].createdAt,
    );
    const notes =
      adjustmentsTotal > 0
        ? `Weekly settlement (week of ${weekLabel}) — bulk marked paid from Payout management. Includes −₹${adjustmentsTotal} in cancellation penalties (${adjustments.length}).`
        : `Weekly settlement (week of ${weekLabel}) — bulk marked paid from Payout management`;
    // One transaction per partner — payout row + earning/adjustment
    // links land together or not at all.
    await prisma.$transaction(async (tx) => {
      const payout = await tx.payout.create({
        data: {
          partnerId,
          amount,
          earningsCount: earnings.length,
          status: 'paid',
          periodStart,
          periodEnd: new Date(end.getTime() - 1),
          paidAt: now,
          notes,
        },
      });
      await tx.partnerEarning.updateMany({
        where: { id: { in: earnings.map((e) => e.id) } },
        data: { status: 'paid', paidAt: now, payoutId: payout.id },
      });
      if (adjustments.length > 0) {
        await tx.partnerAdjustment.updateMany({
          where: { id: { in: adjustments.map((a) => a.id) } },
          data: { payoutId: payout.id, status: 'applied' },
        });
      }
    });
    updated += earnings.length;
  }

  return { updated, payouts: byPartner.size };
};

/// Monthly settlement report — calendar-month aggregation per partner
/// with the FULL GST breakdown, built for the accountant: partner gross,
/// partner 5% GST, partner net, Dhoond commission, Dhoond 18% GST,
/// Dhoond net, and how much of the month is settled vs outstanding.
exports.monthlyReport = async ({ month, scope }) => {
  const start = new Date(`${month}-01T00:00:00`);
  if (Number.isNaN(start.getTime())) throw ApiError.badRequest('Invalid month');
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);

  const rows = await prisma.partnerEarning.findMany({
    where: {
      createdAt: { gte: start, lt: end },
      status: { not: 'reversed' },
      ...partnerCityWhere(scope),
    },
    include: {
      partner: {
        select: {
          id: true,
          name: true,
          businessName: true,
          phone: true,
          city: true,
          cityRef: { select: { name: true, state: { select: { name: true } } } },
          document: { select: { bankAccount: true, bankIfsc: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const byPartner = new Map();
  for (const e of rows) {
    let agg = byPartner.get(e.partnerId);
    if (!agg) {
      agg = {
        partnerId: e.partnerId,
        name: e.partner?.name ?? e.partner?.businessName ?? `Partner #${e.partnerId}`,
        phone: e.partner?.phone ?? '',
        city: e.partner?.cityRef?.name ?? e.partner?.city ?? null,
        state: e.partner?.cityRef?.state?.name ?? null,
        bankAccount: e.partner?.document?.bankAccount ?? null,
        bankIfsc: e.partner?.document?.bankIfsc ?? null,
        jobs: 0,
        grossAmount: 0,
        partnerGross: 0,
        partnerGst: 0,
        partnerNet: 0,
        dhoondCommission: 0,
        dhoondGst: 0,
        dhoondNet: 0,
        paidAmount: 0,
        pendingAmount: 0,
      };
      byPartner.set(e.partnerId, agg);
    }
    /// Exact 2dp split (Booking-report math) — NOT the floored Int
    /// ledger columns, which read ₹0 on small bookings.
    const s = displaySplit(e);
    agg.jobs += 1;
    agg.grossAmount += e.bookingAmount;
    agg.partnerGross += s.partnerGross;
    agg.partnerGst += s.partnerGst;
    agg.partnerNet += s.partnerNet;
    agg.dhoondCommission += s.dhoondGross;
    agg.dhoondGst += s.dhoondGst;
    agg.dhoondNet += s.dhoondNet;
    if (e.status === 'paid') agg.paidAmount += s.partnerNet;
    else agg.pendingAmount += s.partnerNet;
  }

  const MONEY_KEYS = [
    'grossAmount', 'partnerGross', 'partnerGst', 'partnerNet',
    'dhoondCommission', 'dhoondGst', 'dhoondNet', 'paidAmount', 'pendingAmount',
  ];
  const items = [...byPartner.values()]
    .map((a) => {
      /// Float-drift guard on the accumulated figures.
      for (const k of MONEY_KEYS) a[k] = money2(a[k]);
      return a;
    })
    .sort((x, y) => y.partnerNet - x.partnerNet);
  const sum = (key) => money2(items.reduce((s, a) => s + a[key], 0));

  return {
    month,
    monthStart: start.toISOString(),
    monthEnd: new Date(end.getTime() - 1).toISOString(),
    totals: {
      partners: items.length,
      jobs: sum('jobs'),
      grossAmount: sum('grossAmount'),
      partnerGross: sum('partnerGross'),
      partnerGst: sum('partnerGst'),
      partnerNet: sum('partnerNet'),
      dhoondCommission: sum('dhoondCommission'),
      dhoondGst: sum('dhoondGst'),
      dhoondNet: sum('dhoondNet'),
      paidAmount: sum('paidAmount'),
      pendingAmount: sum('pendingAmount'),
    },
    items,
  };
};

/// Upsert (or clear, when remark is empty) the admin note on a
/// partner's weekly settlement — "transfer bounced, retry Friday",
/// "wrong IFSC — asked partner to update bank", etc.
exports.weeklySaveRemark = async ({ weekStart, partnerId, remark }) => {
  const { start } = weekRange(weekStart);
  const text = String(remark ?? '').trim();
  if (!text) {
    await prisma.weeklySettlementNote.deleteMany({
      where: { partnerId: Number(partnerId), weekStart: start },
    });
    return { partnerId: Number(partnerId), remark: null };
  }
  const note = await prisma.weeklySettlementNote.upsert({
    where: {
      partnerId_weekStart: { partnerId: Number(partnerId), weekStart: start },
    },
    create: { partnerId: Number(partnerId), weekStart: start, remark: text },
    update: { remark: text },
  });
  return { partnerId: note.partnerId, remark: note.remark };
};
