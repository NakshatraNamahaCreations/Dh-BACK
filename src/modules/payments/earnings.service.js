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
  const amt  = Number(bookingAmount);  // must be grandTotal (customer-facing)
  const pPct = Number(partnerPct);
  const dPct = 100 - pPct;

  const earnedAmount     = Math.floor(amt * pPct / 100);
  const dhoondCommission = Math.floor(amt * dPct / 100);

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
  // Use grandTotal (what customer paid) as the commission base, not
  // the pre-tax `total`. grandTotal is the all-in price; partner earns
  // their % of that, then 5% GST is deducted from their share.
  // PAID add-ons join the base — the customer settled that money for
  // this job too. Unpaid add-ons are excluded (no money came in).
  const addOnPaidTotal = (booking.addOns ?? [])
    .filter((a) => a.status === 'paid')
    .reduce((s, a) => s + a.price * a.qty, 0);
  const base = (booking.grandTotal ?? booking.total) + addOnPaidTotal;
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
      bookingAmount:    booking.total,
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

  /// Single grouped aggregate per metric — far cheaper than running
  /// the three queries above per-partner.
  const [pending, lifetime, lastPaid, pendingAdj] = await Promise.all([
    prisma.partnerEarning.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds }, status: 'pending' },
      _sum: { earnedAmount: true, netAmount: true },
      _count: { _all: true },
    }),
    prisma.partnerEarning.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds } },
      _sum: { earnedAmount: true, netAmount: true },
      _count: { _all: true },
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

  const pendingByPid = new Map(pending.map((r) => [r.partnerId, r]));
  const lifetimeByPid = new Map(lifetime.map((r) => [r.partnerId, r]));
  const lastPaidByPid = new Map(lastPaid.map((r) => [r.partnerId, r]));
  const pendingAdjByPid = new Map(pendingAdj.map((r) => [r.partnerId, r]));

  const data = partners.map((p) => {
    const pe = pendingByPid.get(p.id);
    const lt = lifetimeByPid.get(p.id);
    const lp = lastPaidByPid.get(p.id);
    const adj = pendingAdjByPid.get(p.id);
    const pendingDeductions = adj?._sum.amount ?? 0;
    // Use netAmount (post-GST) when available, fall back to earnedAmount
    // for legacy rows that were created before the breakdown columns were added.
    const pendingNet  = pe?._sum.netAmount  ?? pe?._sum.earnedAmount  ?? 0;
    const lifetimeNet = lt?._sum.netAmount  ?? lt?._sum.earnedAmount  ?? 0;
    return {
      partnerId: p.id,
      partner: p.name ?? p.businessName ?? `Partner ${p.id}`,
      phone: p.phone,
      categoryId: p.categoryId,
      city: p.cityRef?.name ?? p.city ?? null,
      state: p.cityRef?.state?.name ?? null,
      stateCode: p.cityRef?.state?.code ?? null,
      pendingAmount: pendingNet - pendingDeductions,
      pendingJobs: pe?._count._all ?? 0,
      /// Surfaced so the payout table can show "−₹X penalties" alongside
      /// the net pending figure.
      pendingDeductions,
      lifetimeAmount: lifetimeNet,
      lifetimeJobs: lt?._count._all ?? 0,
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
        partnerGst: 0,
        payable: 0,
        paidJobs: 0,
      };
      byPartner.set(e.partnerId, agg);
    }
    agg.jobs += 1;
    agg.grossAmount += e.bookingAmount;
    agg.commission += e.dhoondCommission;
    agg.partnerGst += e.partnerGst;
    /// What actually lands in the partner's bank for the week.
    agg.payable += e.netAmount;
    if (e.status === 'paid') agg.paidJobs += 1;
  }

  /// This week's still-unpaid net per partner (drives "week pending").
  const weekPendingByPartner = new Map();
  for (const e of rows) {
    if (e.status === 'paid' || e.status === 'reversed') continue;
    weekPendingByPartner.set(
      e.partnerId,
      (weekPendingByPartner.get(e.partnerId) ?? 0) + e.netAmount,
    );
  }

  /// Carry-forward: unpaid earnings from BEFORE this week — the "last
  /// week(s) pending" the accountant must chase. Grouped per partner so
  /// old dues surface even when the partner had no jobs this week.
  const carryRows = await prisma.partnerEarning.groupBy({
    by: ['partnerId'],
    where: {
      createdAt: { lt: start },
      status: { notIn: ['paid', 'reversed'] },
      ...partnerCityWhere(scope),
    },
    _sum: { netAmount: true },
    _count: { _all: true },
  });
  const carryByPartner = new Map(
    carryRows.map((c) => [c.partnerId, { amount: c._sum.netAmount ?? 0, jobs: c._count._all }]),
  );

  /// Partners with old dues but NO earnings this week still need a row
  /// (otherwise their dues silently vanish from the screen).
  const missingIds = carryRows
    .map((c) => c.partnerId)
    .filter((id) => !byPartner.has(id) && (carryByPartner.get(id)?.amount ?? 0) > 0);
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
      const weekPending = weekPendingByPartner.get(a.partnerId) ?? 0;
      const carry = carryByPartner.get(a.partnerId) ?? { amount: 0, jobs: 0 };
      return {
        ...a,
        weekPending,
        /// Old dues from previous weeks (still unpaid).
        carryForward: carry.amount,
        carryForwardJobs: carry.jobs,
        /// Everything the partner is owed as of this week's end.
        totalDue: weekPending + carry.amount,
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
      payable: items.reduce((s, a) => s + a.payable, 0),
      pendingPayable: items.reduce((s, a) => s + a.weekPending, 0),
      carryForward: items.reduce((s, a) => s + a.carryForward, 0),
      totalDue: items.reduce((s, a) => s + a.totalDue, 0),
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

  const now = new Date();
  const weekLabel = start.toISOString().slice(0, 10);
  let updated = 0;

  for (const [partnerId, earnings] of byPartner) {
    const amount = earnings.reduce(
      (s, e) => s + (e.netAmount > 0 ? e.netAmount : e.earnedAmount),
      0,
    );
    const periodStart = earnings.reduce(
      (min, e) => (e.createdAt < min ? e.createdAt : min),
      earnings[0].createdAt,
    );
    // One transaction per partner — payout row + earning links land
    // together or not at all.
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
          notes: `Weekly settlement (week of ${weekLabel}) — bulk marked paid from Payout management`,
        },
      });
      await tx.partnerEarning.updateMany({
        where: { id: { in: earnings.map((e) => e.id) } },
        data: { status: 'paid', paidAt: now, payoutId: payout.id },
      });
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
    agg.jobs += 1;
    agg.grossAmount += e.bookingAmount;
    agg.partnerGross += e.earnedAmount;
    agg.partnerGst += e.partnerGst;
    agg.partnerNet += e.netAmount;
    agg.dhoondCommission += e.dhoondCommission;
    agg.dhoondGst += e.dhoondGst;
    agg.dhoondNet += e.dhoondNet;
    if (e.status === 'paid') agg.paidAmount += e.netAmount;
    else agg.pendingAmount += e.netAmount;
  }

  const items = [...byPartner.values()].sort((x, y) => y.partnerNet - x.partnerNet);
  const sum = (key) => items.reduce((s, a) => s + a[key], 0);

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
