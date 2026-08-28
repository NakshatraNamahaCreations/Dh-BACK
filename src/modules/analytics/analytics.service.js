const prisma = require('../../config/prisma');
const { areaFromAddress } = require('../../utils/area');
const { applyScopeToWhere, applyScopeToRelation } = require('../../middlewares/adminScope');

// ── Scope helpers ────────────────────────────────────────────────────────────
//
// Every query in this module is filtered to the requesting admin's
// cities. Bookings and partners carry a `cityId` directly; customers
// don't, so they're scoped through their bookings' city. All three are
// no-ops for a SUPER admin (scope.cityIds === null) — they see the whole
// platform exactly as before.

/// Booking / partner WHERE (both have a cityId column).
const withCityScope = (where, scope) => {
  if (scope) applyScopeToWhere(where, scope);
  return where;
};
/// Customer WHERE — scoped via the related bookings' cityId.
const withCustomerScope = (where, scope) => {
  if (scope) applyScopeToRelation(where, scope, 'bookings');
  return where;
};

// ── Helpers ────────────────────────────────────────────────────────────────

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90, '180d': 180 };

const dateFromRange = (range = '7d') => {
  const days = RANGE_DAYS[range] ?? 7;
  const from = new Date();
  from.setDate(from.getDate() - days);
  from.setHours(0, 0, 0, 0);
  return { from, days };
};

const fmtDay = (d) =>
  d.toLocaleDateString('en-IN', { weekday: 'short' });

/// LOCAL calendar-date key (YYYY-MM-DD).
///
/// `toISOString().slice(0,10)` cannot be used here: it converts to UTC
/// first, so IST local-midnight (00:00 +05:30) becomes 18:30 the PREVIOUS
/// day and every bucket key landed one day early. Bookings were then keyed
/// off raw UTC while buckets were keyed off shifted-local, so today's rows
/// matched no bucket at all and the revenue trend sat flat at ₹0 on days
/// that clearly had revenue.
const localDayKey = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// ── Dashboard summary ──────────────────────────────────────────────────────

exports.summary = async (scope) => {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const [todayBookings, yesterdayBookings, activePartners] = await Promise.all([
    prisma.booking.findMany({
      where: withCityScope({ createdAt: { gte: todayStart } }, scope),
      select: { total: true, grandTotal: true, status: true },
    }),
    prisma.booking.findMany({
      where: withCityScope({ createdAt: { gte: yesterdayStart, lt: todayStart } }, scope),
      select: { total: true, grandTotal: true },
    }),
    prisma.partner.count({ where: withCityScope({ isActive: true }, scope) }),
  ]);

  /// Revenue = what the CUSTOMER PAID (`grandTotal`, GST included) so the
  /// dashboard reconciles with the amounts on Booking history / Booking
  /// report. It previously summed `total` (pre-GST), which made the card
  /// read ₹60 against ₹71 of bookings for the same day with no explanation.
  /// `grandTotal` falls back to `total` for legacy rows written before the
  /// column existed.
  const paid = (b) => b.grandTotal || b.total || 0;
  const todayRevenue = todayBookings
    .filter((b) => b.status !== 'CANCELLED')
    .reduce((s, b) => s + paid(b), 0);
  const yesterdayRevenue = yesterdayBookings.reduce((s, b) => s + paid(b), 0);
  const todayJobs = todayBookings.filter((b) => b.status !== 'CANCELLED').length;
  const yesterdayJobs = yesterdayBookings.length;

  const pct = (curr, prev) => (prev > 0 ? ((curr - prev) / prev) * 100 : curr > 0 ? 100 : 0);

  // Pending payouts — sum of completed bookings not yet "paid out". Since we
  // don't have a payouts table yet, approximate as sum of completed bookings
  // in the last 7 days at 75% of total (rough partner share).
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCompleted = await prisma.booking.aggregate({
    where: withCityScope({ status: 'COMPLETED', updatedAt: { gte: sevenDaysAgo } }, scope),
    _sum: { total: true },
  });
  const pendingPayouts = Math.round(((recentCompleted._sum.total ?? 0) * 0.75));

  return {
    todayRevenue,
    todayJobs,
    activePartners,
    pendingPayouts,
    revenueDeltaPercent: Number(pct(todayRevenue, yesterdayRevenue).toFixed(1)),
    jobsDeltaPercent: Number(pct(todayJobs, yesterdayJobs).toFixed(1)),
  };
};

// ── Revenue series ─────────────────────────────────────────────────────────

exports.revenueSeries = async ({ range = '7d' } = {}, scope) => {
  const { from, days } = dateFromRange(range);

  const bookings = await prisma.booking.findMany({
    where: withCityScope({ createdAt: { gte: from }, status: { not: 'CANCELLED' } }, scope),
    select: { total: true, grandTotal: true, createdAt: true },
  });

  /// Group by ISO date, over a window that ENDS TODAY.
  /// `dateFromRange` starts at (today − days), so building `days` buckets
  /// from it ended at YESTERDAY — today's bookings hashed to a key with no
  /// bucket and were silently dropped, leaving the trend flat at ₹0 even on
  /// a day with revenue. Anchor on today and walk backwards instead.
  const buckets = new Map();
  const seriesStart = new Date();
  seriesStart.setHours(0, 0, 0, 0);
  seriesStart.setDate(seriesStart.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const d = new Date(seriesStart); d.setDate(d.getDate() + i);
    const key = localDayKey(d);
    buckets.set(key, { day: fmtDay(d), revenue: 0, jobs: 0 });
  }
  for (const b of bookings) {
    const key = localDayKey(b.createdAt);
    const bucket = buckets.get(key);
    if (bucket) {
      /// Same basis as the summary card — customer-paid, GST included.
      bucket.revenue += b.grandTotal || b.total || 0;
      bucket.jobs += 1;
    }
  }
  return Array.from(buckets.values());
};

/**
 * Split what a booking ACTUALLY earned across its line items.
 *
 * Category revenue used to sum `basePrice * qty` — the sticker value. That
 * ignores discounts and coupons entirely, so a ₹569 job bought with a ₹566
 * coupon reported ₹569 of revenue when ₹3 was collected.
 *
 * Each line gets a share of the real amount in proportion to its sticker
 * value, and the LAST line takes the remainder, so the per-category numbers
 * always add back up to the booking total instead of drifting by a rupee.
 *
 * `amount` is whatever the caller counts as earned — the paid grand total
 * for revenue, zero for a booking nobody has paid for yet.
 */
const allocateAcrossItems = (items, amount) => {
  const sticker = items.reduce((sum, it) => sum + it.basePrice * it.qty, 0);
  let allocated = 0;
  return items.map((it, idx) => {
    const share =
      idx === items.length - 1
        ? amount - allocated
        : sticker > 0
          ? Math.round((amount * it.basePrice * it.qty) / sticker)
          : 0;
    allocated += share;
    return share;
  });
};

// ── Booking analytics ──────────────────────────────────────────────────────

exports.bookingAnalytics = async ({ range = '7d' } = {}, scope) => {
  const { from } = dateFromRange(range);

  const bookings = await prisma.booking.findMany({
    /// Exclude abandoned attempts — CANCELLED and never paid (`paidAt`
    /// null): checkout bailed, payment failed, or dispatch found nobody.
    /// No money moved and no work happened, so counting them skewed the
    /// funnel (8 of 11 "requested"), the peak-hour curve, and category
    /// revenue. A PAID-then-cancelled booking is real and stays.
    where: withCityScope(
      { createdAt: { gte: from }, NOT: { status: 'CANCELLED', paidAt: null } },
      scope,
    ),
    include: {
      items: {
        include: { service: { include: { category: { select: { id: true, name: true } } } } },
      },
      /// Joined address — new bookings carry FK-only, so deriving
      /// "area" from `b.addressLine` reads null without this join.
      /// Falls back to the legacy snapshot columns below.
      customerAddress: { select: { addressLine: true, city: true } },
    },
  });

  const requested = bookings.length;
  const accepted = bookings.filter((b) => b.status !== 'PENDING').length;
  const enroute = bookings.filter((b) => b.status === 'IN_PROGRESS').length;
  const completed = bookings.filter((b) => b.status === 'COMPLETED').length;
  const cancelled = bookings.filter((b) => b.status === 'CANCELLED').length;

  // By area (top 8 by jobs).
  const byAreaMap = new Map();
  for (const b of bookings) {
    /// Prefer the canonical address from customer_addresses; fall
    /// back to the legacy snapshot columns for pre-refactor rows.
    const line = b.customerAddress?.addressLine ?? b.addressLine ?? '';
    const city = b.customerAddress?.city ?? b.city ?? '';
    /// Shared with the admin Booking History column. `split(',')[0]` here
    /// returned the HOUSE NUMBER, so this chart plotted areas like "1002"
    /// and "393" instead of localities.
    const area = areaFromAddress(line, city) || city || 'Unknown';
    byAreaMap.set(area, (byAreaMap.get(area) ?? 0) + 1);
  }
  const maxAreaJobs = Math.max(...byAreaMap.values(), 1);
  const byArea = Array.from(byAreaMap.entries())
    .map(([area, jobs]) => ({ area, jobs, demand: Math.round((jobs / maxAreaJobs) * 100) }))
    .sort((a, b) => b.jobs - a.jobs)
    .slice(0, 8);

  // By category.
  const byCatMap = new Map();
  for (const b of bookings) {
    /// Revenue is money COLLECTED, not the price on the label. A booking
    /// that hasn't been paid for contributes jobs but no revenue.
    const shares = allocateAcrossItems(b.items, b.paidAt ? b.grandTotal : 0);
    b.items.forEach((it, idx) => {
      const cat = it.service?.category?.name ?? 'Other';
      const e = byCatMap.get(cat) ?? { jobs: 0, revenue: 0 };
      e.jobs += 1;
      e.revenue += shares[idx];
      byCatMap.set(cat, e);
    });
  }
  const byCategory = Array.from(byCatMap.entries())
    .map(([category, v]) => ({ category, jobs: v.jobs, revenue: v.revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  // By hour (00..23).
  const byHourMap = new Map();
  for (let h = 0; h < 24; h++) byHourMap.set(h, 0);
  for (const b of bookings) {
    const h = new Date(b.scheduledAt).getHours();
    byHourMap.set(h, (byHourMap.get(h) ?? 0) + 1);
  }
  const byHour = Array.from(byHourMap.entries()).map(([h, jobs]) => ({
    hour: `${String(h).padStart(2, '0')}:00`,
    jobs,
  }));

  return {
    funnel: { requested, accepted, enroute, completed, cancelled },
    byArea,
    byCategory,
    byHour,
    completionRate: requested > 0 ? completed / requested : 0,
    cancellationRate: requested > 0 ? cancelled / requested : 0,
  };
};

// ── Revenue report ─────────────────────────────────────────────────────────

exports.revenueReport = async ({ range = '30d' } = {}, scope) => {
  const { from } = dateFromRange(range);
  const series = await exports.revenueSeries({ range }, scope);

  const bookings = await prisma.booking.findMany({
    where: withCityScope({ createdAt: { gte: from } }, scope),
    include: {
      items: {
        include: { service: { include: { category: { select: { name: true } } } } },
      },
    },
  });

  const completed = bookings.filter((b) => b.status === 'COMPLETED');
  const cancelled = bookings.filter((b) => b.status === 'CANCELLED');

  /// `grandTotal` is what the customer paid; `total` is the pre-tax base,
  /// which reads lower than every figure on the booking.
  const gmv = completed.reduce((s, b) => s + b.grandTotal, 0);
  // Default 20% commission across the board until Setting-driven.
  const commission = Math.round(gmv * 0.2);
  const payout = gmv - commission;
  const refunds = cancelled.reduce((s, b) => s + b.grandTotal, 0);

  // By category.
  const byCatMap = new Map();
  for (const b of completed) {
    /// Same rule as the booking analytics: split what the customer actually
    /// paid, not the sticker price, so a discounted job doesn't inflate its
    /// category.
    const shares = allocateAcrossItems(b.items, b.grandTotal);
    b.items.forEach((it, idx) => {
      const cat = it.service?.category?.name ?? 'Other';
      const e = byCatMap.get(cat) ?? { gmv: 0, commission: 0, payout: 0 };
      const lineGmv = shares[idx];
      e.gmv += lineGmv;
      e.commission += Math.round(lineGmv * 0.2);
      e.payout += lineGmv - Math.round(lineGmv * 0.2);
      byCatMap.set(cat, e);
    });
  }
  const byCategory = Array.from(byCatMap.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.gmv - a.gmv);

  // MoM growth (compare second half of range vs first half).
  const half = Math.floor(series.length / 2);
  const firstHalf = series.slice(0, half).reduce((s, p) => s + p.revenue, 0);
  const secondHalf = series.slice(half).reduce((s, p) => s + p.revenue, 0);
  const growthMoM =
    firstHalf > 0 ? Number((((secondHalf - firstHalf) / firstHalf) * 100).toFixed(1)) : 0;

  return {
    series,
    byCategory,
    totals: { gmv, commission, payout, refunds },
    growthMoM,
  };
};

// ── Booking report ───────────────────────────────────────────────────────────
//
// A filterable, exportable booking ledger with a full earnings breakup.
// Filters: explicit from/to dates (falls back to `range`), stateId, cityId,
// customerId, partnerId, status. Every filter composes into one Prisma WHERE
// and stays inside the admin's city scope.
//
// Earnings model (whole rupees, per the Booking pricing snapshot):
//   total        — partner-facing job amount (commission + earning base)
//   partnerEarn  — PartnerEarning.earnedAmount for completed jobs (the
//                  partner's actual credited share). 0 when not completed.
//   commission   — total − partnerEarn (Dhoond's cut of the job amount)
//   platformFee  — 2% platform fee charged on top (Dhoond income)
//   gstAmount    — 18% GST (government pass-through, NOT Dhoond income)
//   dhoondEarn   — commission + platformFee
//   grandTotal   — what the customer paid = total + gst + platformFee
//
// `refunds` is the grandTotal of CANCELLED bookings (money returned), shown
// separately from the earnings of live/completed bookings.

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

exports.bookingReport = async (query = {}, scope) => {
  const { stateId, cityId, customerId, partnerId, status } = query;
  /// Abandoned attempts = CANCELLED and never paid (`paidAt` null): the
  /// customer bailed at checkout, payment failed, or dispatch found no
  /// partner and the row auto-cancelled. No money ever moved, so counting
  /// them as bookings — and worse, as REFUNDS — overstates both volume and
  /// money returned. Hidden by default; `includeAbandoned=true` brings them
  /// back for anyone auditing failed attempts.
  /// A cancelled booking that WAS paid is real business (a genuine refund)
  /// and always stays in the report.
  const includeAbandoned = String(query.includeAbandoned ?? '') === 'true';

  // Date window — explicit from/to wins; otherwise fall back to `range`.
  const from = parseDate(query.from);
  const to = parseDate(query.to);
  let createdAt;
  if (from || to) {
    createdAt = {};
    if (from) { from.setHours(0, 0, 0, 0); createdAt.gte = from; }
    if (to) { to.setHours(23, 59, 59, 999); createdAt.lte = to; }
  } else {
    const r = dateFromRange(query.range ?? '30d');
    createdAt = { gte: r.from };
  }

  // City scope: an explicit cityId filter must still respect the admin's
  // scope. If a stateId is given, resolve its cities and AND them in.
  const where = withCityScope({ createdAt }, scope);
  if (customerId) where.customerId = Number(customerId);
  if (partnerId) where.partnerId = Number(partnerId);
  if (status) where.status = status;
  if (!includeAbandoned) {
    /// NOT(status = CANCELLED AND paidAt = null) — keeps every non-cancelled
    /// row and every paid-then-cancelled (refunded) row.
    where.NOT = [...(where.NOT ?? []), { status: 'CANCELLED', paidAt: null }];
  }

  if (cityId) {
    where.cityId = Number(cityId);
  } else if (stateId) {
    const cities = await prisma.city.findMany({
      where: { stateId: Number(stateId) },
      select: { id: true },
    });
    const ids = cities.map((c) => c.id);
    // Empty state → no rows (rather than silently ignoring the filter).
    where.cityId = { in: ids.length ? ids : [-1] };
  }

  /// Pagination — the report used to fetch EVERY matching row with full
  /// joins on each load, which grows unbounded with booking volume. Rows
  /// are now paged server-side; the earnings totals still cover the
  /// WHOLE filtered set via a lean money-only scan below (no joins), so
  /// the summary cards and the table footer stay exact regardless of
  /// which page is on screen. `export=true` returns the full (bounded)
  /// row set in one response for the CSV download.
  const exportAll = String(query.export ?? '') === 'true';
  const EXPORT_CAP = 5000;
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize) || 25));

  /// Two-decimal money for DISPLAY. The PartnerEarning row stores whole
  /// rupees (Int columns — the actual credited amounts, floored so we
  /// never credit more than authorised), which reads as ₹0 everywhere on
  /// a small booking: 80% of ₹1 floors to ₹0. The REPORT recomputes the
  /// exact split (2dp) from the SAME snapshotted inputs the earning row
  /// froze (bookingAmount × commissionPct), so ₹1 shows as ₹0.80/₹0.20
  /// here while the persisted ledger stays untouched.
  const money2 = (v) => Math.round(v * 100) / 100;
  const splitFor = (e) => {
    if (!e) {
      return {
        partnerGross: 0, partnerGst: 0, partnerNet: 0,
        dhoondGross: 0, dhoondGstAmt: 0, dhoondNet: 0,
      };
    }
    const base = e.bookingAmount ?? 0;
    const pct = e.commissionPct ?? 80;
    const partnerGross = money2((base * pct) / 100);
    const dhoondGross = money2(base - partnerGross);
    const partnerGst = money2((partnerGross * 5) / 100);
    const dhoondGstAmt = money2((dhoondGross * 18) / 100);
    return {
      partnerGross,
      dhoondGross,
      partnerGst,
      dhoondGstAmt,
      partnerNet: money2(partnerGross - partnerGst),
      dhoondNet: money2(dhoondGross - dhoondGstAmt),
    };
  };

  const [bookings, leanRows] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        partner: { select: { id: true, name: true, businessName: true, phone: true } },
        /// `cityRef` is the City relation (cityId FK). The scalar `city`
        /// column is the legacy free-text snapshot, used as fallback.
        cityRef: { select: { id: true, name: true, state: { select: { id: true, name: true } } } },
        /// Snapshotted split inputs — the exact 2dp split is derived from
        /// these (see splitFor above).
        earning: { select: { bookingAmount: true, commissionPct: true } },
        items: { include: { service: { select: { name: true, category: { select: { name: true } } } } } },
      },
      ...(exportAll
        ? { take: EXPORT_CAP }
        : { skip: (page - 1) * pageSize, take: pageSize }),
    }),
    /// Money-only scan of the FULL filtered set — powers the totals so
    /// they never shrink to just the visible page. No joins besides the
    /// earning snapshot; bounded as a runaway guard.
    prisma.booking.findMany({
      where,
      select: {
        status: true, total: true, subtotal: true, discount: true,
        grandTotal: true, platformFee: true, gstAmount: true,
        earning: { select: { bookingAmount: true, commissionPct: true } },
      },
      take: 20000,
    }),
  ]);

  const rows = bookings.map((b) => {
    const isCancelled = b.status === 'CANCELLED';
    /// Client settlement sheet, per booking. Base is the POST-DISCOUNT
    /// amount the customer actually paid — splitting the sticker price
    /// would credit a partner more than was collected.
    const e = b.earning;
    const discount = b.discount ?? 0;
    const { partnerGross, partnerGst, partnerNet, dhoondGross, dhoondGstAmt, dhoondNet } =
      splitFor(e);
    const partnerEarn = partnerGross;
    // Commission only makes sense once a partner share exists (completed).
    // For non-completed/non-cancelled rows we still show the job amount but
    // leave the split at 0 so totals aren't inflated by unrealised revenue.
    const commission = e ? money2(Math.max(0, b.total - partnerEarn)) : 0;
    const platformFee = b.platformFee ?? 0;
    const gst = b.gstAmount ?? 0;
    const dhoondEarn = money2(commission + platformFee);
    const services = b.items.map((it) => it.service?.name).filter(Boolean).join(', ');
    const category = b.items[0]?.service?.category?.name ?? '—';

    return {
      id: b.id,
      bookingRef: b.bookingRef ?? `#${b.id}`,
      date: b.createdAt,
      scheduledAt: b.scheduledAt,
      status: b.status,
      paymentStatus: b.paymentStatus,
      paymentMethod: b.paymentMethod,
      customerId: b.customer?.id ?? b.customerId,
      customerName: b.customer?.name ?? '—',
      customerPhone: b.customer?.phone ?? '',
      partnerId: b.partner?.id ?? null,
      partnerName: b.partner?.name ?? b.partner?.businessName ?? '—',
      partnerPhone: b.partner?.phone ?? '',
      stateId: b.cityRef?.state?.id ?? null,
      state: b.cityRef?.state?.name ?? '—',
      cityId: b.cityRef?.id ?? null,
      city: b.cityRef?.name ?? b.city ?? '—',
      category,
      services,
      // Money (whole rupees)
      /// Sticker minus what the coupon took off — shown so a discounted
      /// booking's smaller split is explainable rather than looking wrong.
      subtotal: b.subtotal ?? 0,
      discount,
      jobAmount: b.total,
      /// Settlement split, exactly as persisted (client formula):
      ///   base × partnerPct  → gross, less 5% GST  → credited to partner
      ///   base × dhoondPct   → gross, less 18% GST → Dhoond after tax
      partnerGross: isCancelled ? 0 : partnerGross,
      partnerGst: isCancelled ? 0 : partnerGst,
      partnerNet: isCancelled ? 0 : partnerNet,
      dhoondGross: isCancelled ? 0 : dhoondGross,
      dhoondGst: isCancelled ? 0 : dhoondGstAmt,
      dhoondNet: isCancelled ? 0 : dhoondNet,
      commissionPct: b.earning?.commissionPct ?? null,
      partnerEarning: isCancelled ? 0 : partnerEarn,
      commission: isCancelled ? 0 : commission,
      platformFee: isCancelled ? 0 : platformFee,
      gst: isCancelled ? 0 : gst,
      dhoondEarning: isCancelled ? 0 : dhoondEarn,
      grandTotal: b.grandTotal,
      refund: isCancelled ? b.grandTotal : 0,
    };
  });

  // Totals over the WHOLE filtered set (leanRows), not just the visible
  // page — live/completed feed the earnings split; cancelled feed refunds.
  // Mirrors the per-row math above exactly.
  const totals = leanRows.reduce(
    (t, b) => {
      const isCancelled = b.status === 'CANCELLED';
      const split = splitFor(b.earning);
      const partnerEarn = isCancelled ? 0 : split.partnerGross;
      const commission =
        !isCancelled && b.earning ? money2(Math.max(0, b.total - partnerEarn)) : 0;
      const platformFee = isCancelled ? 0 : (b.platformFee ?? 0);
      t.bookings += 1;
      if (b.status === 'COMPLETED') t.completed += 1;
      else if (isCancelled) t.cancelled += 1;
      t.jobAmount += b.total;
      t.partnerEarning += partnerEarn;
      t.commission += commission;
      t.platformFee += platformFee;
      t.gst += isCancelled ? 0 : (b.gstAmount ?? 0);
      t.dhoondEarning += money2(commission + platformFee);
      t.grandTotal += b.grandTotal;
      t.subtotal += b.subtotal ?? 0;
      t.discount += b.discount ?? 0;
      t.partnerGross += isCancelled ? 0 : split.partnerGross;
      t.partnerGstAmt += isCancelled ? 0 : split.partnerGst;
      t.partnerNet += isCancelled ? 0 : split.partnerNet;
      t.dhoondGross += isCancelled ? 0 : split.dhoondGross;
      t.dhoondGstAmt += isCancelled ? 0 : split.dhoondGstAmt;
      t.dhoondNet += isCancelled ? 0 : split.dhoondNet;
      t.refund += isCancelled ? b.grandTotal : 0;
      return t;
    },
    {
      bookings: 0, completed: 0, cancelled: 0,
      jobAmount: 0, partnerEarning: 0, commission: 0,
      platformFee: 0, gst: 0, dhoondEarning: 0, grandTotal: 0, refund: 0,
      subtotal: 0, discount: 0,
      partnerGross: 0, partnerGstAmt: 0, partnerNet: 0,
      dhoondGross: 0, dhoondGstAmt: 0, dhoondNet: 0,
    },
  );
  /// Kill float noise from summing 2dp row values (0.8 + 0.1 → 0.9000…01)
  /// so the frontend renders clean paise.
  for (const k of [
    'jobAmount', 'partnerEarning', 'commission', 'platformFee', 'gst',
    'dhoondEarning', 'grandTotal', 'refund', 'subtotal', 'discount',
    'partnerGross', 'partnerGstAmt', 'partnerNet',
    'dhoondGross', 'dhoondGstAmt', 'dhoondNet',
  ]) {
    totals[k] = Math.round(totals[k] * 100) / 100;
  }
  /// Take rate against CUSTOMER-PAID (grand total), not the pre-GST base.
  /// The card now leads with customer-paid, so dividing by the GST-stripped
  /// base made the percentage look unrelated to the numbers on screen
  /// (₹4 ÷ ₹63 = 6.3% while the card showed ₹74).
  totals.takeRate = totals.grandTotal > 0 ? totals.dhoondEarning / totals.grandTotal : 0;

  return {
    rows,
    totals,
    meta: {
      page: exportAll ? 1 : page,
      pageSize: exportAll ? rows.length : pageSize,
      total: leanRows.length,
      totalPages: exportAll ? 1 : Math.max(1, Math.ceil(leanRows.length / pageSize)),
    },
  };
};

// ── Partner performance ────────────────────────────────────────────────────

exports.partnerPerformance = async ({ range = '30d' } = {}, scope) => {
  const { from, days } = dateFromRange(range);
  const priorFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

  /// Scope the partner SET to the admin's cities; every downstream
  /// query filters by `partnerId IN (this set)`, so bookings/earnings/
  /// ratings inherit the scope automatically.
  const partners = await prisma.partner.findMany({
    where: withCityScope({ isActive: true }, scope),
    select: { id: true, name: true, businessName: true, categoryId: true },
  });
  if (partners.length === 0) return { rows: [], topPerformers: [], atRisk: [] };

  const partnerIds = partners.map((p) => p.id);

  const [currentBookings, currentEarnings, priorEarnings, categories, ratingAgg] = await Promise.all([
    prisma.booking.findMany({
      where: { partnerId: { in: partnerIds }, createdAt: { gte: from } },
      select: { partnerId: true, status: true },
    }),
    prisma.partnerEarning.findMany({
      where: { partnerId: { in: partnerIds }, createdAt: { gte: from } },
      select: { partnerId: true, earnedAmount: true },
    }),
    prisma.partnerEarning.findMany({
      where: { partnerId: { in: partnerIds }, createdAt: { gte: priorFrom, lt: from } },
      select: { partnerId: true, earnedAmount: true },
    }),
    prisma.category.findMany({
      where: { id: { in: partners.map((p) => p.categoryId).filter(Boolean) } },
      select: { id: true, name: true },
    }),
    prisma.bookingRating.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds } },
      _avg: { stars: true },
      _count: { _all: true },
    }),
  ]);

  const categoryById = new Map(categories.map((c) => [c.id, c.name]));
  const ratingByPartner = new Map(
    ratingAgg.map((r) => [r.partnerId, { avg: r._avg.stars ?? 0, count: r._count._all }])
  );

  const stats = new Map();
  for (const p of partners) {
    stats.set(p.id, { completed: 0, cancelled: 0, other: 0, earnings: 0, priorEarnings: 0 });
  }
  for (const b of currentBookings) {
    const s = stats.get(b.partnerId);
    if (!s) continue;
    if (b.status === 'COMPLETED') s.completed++;
    else if (b.status === 'CANCELLED') s.cancelled++;
    else s.other++;
  }
  for (const e of currentEarnings) {
    const s = stats.get(e.partnerId);
    if (s) s.earnings += e.earnedAmount;
  }
  for (const e of priorEarnings) {
    const s = stats.get(e.partnerId);
    if (s) s.priorEarnings += e.earnedAmount;
  }

  const rows = partners.map((p) => {
    const s = stats.get(p.id);
    const attempted = s.completed + s.cancelled + s.other;
    const acceptanceRate = attempted > 0 ? (attempted - s.cancelled) / attempted : 0;
    const completionRate = attempted > 0 ? s.completed / attempted : 0;
    let trend = 'flat';
    if (s.priorEarnings > 0) {
      const ratio = s.earnings / s.priorEarnings;
      if (ratio > 1.1) trend = 'up';
      else if (ratio < 0.9) trend = 'down';
    } else if (s.earnings > 0) {
      trend = 'up';
    }
    const r = ratingByPartner.get(p.id);
    return {
      id: p.id,
      name: p.name ?? p.businessName ?? 'Partner',
      category: (p.categoryId && categoryById.get(p.categoryId)) || p.businessName || 'General',
      jobsCompleted: s.completed,
      hoursWorked: 0,
      earnings: s.earnings,
      rating: r ? Math.round(r.avg * 10) / 10 : 0,
      ratingCount: r ? r.count : 0,
      acceptanceRate: Math.round(acceptanceRate * 100) / 100,
      completionRate: Math.round(completionRate * 100) / 100,
      trend,
    };
  });

  const sortedByEarnings = [...rows].sort((a, b) => b.earnings - a.earnings);
  const topPerformers = sortedByEarnings.filter((r) => r.earnings > 0 || r.jobsCompleted > 0).slice(0, 5);
  const atRisk = rows
    .filter((r) => {
      const attempted = stats.get(r.id);
      const hasActivity = attempted && (attempted.completed + attempted.cancelled + attempted.other) > 0;
      return hasActivity && (r.trend === 'down' || r.completionRate < 0.75);
    })
    .slice(0, 5);

  return { rows, topPerformers, atRisk };
};

// ── Customer insights ──────────────────────────────────────────────────────

exports.customerInsights = async ({ range = '90d' } = {}, scope) => {
  const { from, days } = dateFromRange(range);

  /// Customers have no city of their own — a city manager's "customers"
  /// are those who booked in their city, so scope via the bookings
  /// relation. SUPER admins (null scope) see every customer.
  const customers = await prisma.customer.findMany({
    where: withCustomerScope({ createdAt: { gte: from } }, scope),
    select: { id: true, createdAt: true },
  });
  const allBookings = await prisma.booking.findMany({
    where: withCityScope({ createdAt: { gte: from } }, scope),
    select: { customerId: true, total: true, createdAt: true },
  });

  const byCustomer = new Map();
  for (const b of allBookings) {
    byCustomer.set(b.customerId, (byCustomer.get(b.customerId) ?? 0) + 1);
  }
  const repeatCustomers = Array.from(byCustomer.values()).filter((n) => n >= 2).length;
  const totalCustomers = byCustomer.size;
  const repeatRate = totalCustomers > 0 ? repeatCustomers / totalCustomers : 0;
  const avgFrequency =
    totalCustomers > 0 ? allBookings.length / totalCustomers / Math.max(1, days / 30) : 0;

  // New registrations per day.
  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i);
    buckets.set(d.toISOString().slice(0, 10), { day: fmtDay(d), count: 0 });
  }
  for (const c of customers) {
    const key = c.createdAt.toISOString().slice(0, 10);
    const e = buckets.get(key);
    if (e) e.count += 1;
  }
  const newRegistrations = Array.from(buckets.values());

  // ── Cohort retention — real math against the bookings table ────────────
  //
  // 1. Each customer's "cohort" is the month of their FIRST booking
  //    (not signup month — bookings are what we care about).
  // 2. For each cohort, retention[N] = % of cohort members who placed
  //    at least one booking in the Nth month AFTER their first.
  // 3. We look back COHORT_LOOKBACK_MONTHS so the table doesn't grow
  //    unbounded as the platform ages. 6 months is enough horizon for
  //    a service business; bump later if needed.
  //
  // The data set here is everyone's bookings (not just bookings in
  // the dashboard's `range` window) — cohort analysis needs the full
  // history to compute "first booking month" correctly. The `range`
  // selector on the page still controls the new-registrations chart
  // and KPIs above.
  const COHORT_LOOKBACK_MONTHS = 6;
  const cohortHistory = await prisma.booking.findMany({
    where: withCityScope({}, scope),
    select: { customerId: true, createdAt: true },
  });
  /// firstBookingByCustomer: customerId → epoch-ms of first booking
  const firstBookingByCustomer = new Map();
  for (const b of cohortHistory) {
    const t = b.createdAt.getTime();
    const cur = firstBookingByCustomer.get(b.customerId);
    if (cur == null || t < cur) firstBookingByCustomer.set(b.customerId, t);
  }
  /// cohortMap: 'YYYY-MM' → { customerIds: Set, monthActivity: Map<customerId, Set<monthIndex>> }
  const cohortMap = new Map();
  for (const [customerId, firstMs] of firstBookingByCustomer.entries()) {
    const d = new Date(firstMs);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!cohortMap.has(key)) cohortMap.set(key, { customers: new Set(), activity: new Map() });
    cohortMap.get(key).customers.add(customerId);
  }
  /// Fill activity — for each booking, mark which month index (0 =
  /// first booking month, 1 = next month, ...) the customer was
  /// active in. We use the same firstBookingByCustomer reference so
  /// month index 0 is always 100% for everyone (their first booking).
  for (const b of cohortHistory) {
    const firstMs = firstBookingByCustomer.get(b.customerId);
    if (firstMs == null) continue;
    const first = new Date(firstMs);
    const cur = b.createdAt;
    const monthIdx =
      (cur.getFullYear() - first.getFullYear()) * 12 +
      (cur.getMonth() - first.getMonth());
    if (monthIdx < 0) continue;
    const cohortKey = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`;
    const cohort = cohortMap.get(cohortKey);
    if (!cohort) continue;
    if (!cohort.activity.has(b.customerId)) cohort.activity.set(b.customerId, new Set());
    cohort.activity.get(b.customerId).add(monthIdx);
  }

  /// Build the table — newest cohort first is more useful for ops
  /// reads ("what does last month's signup wave look like at M1?")
  /// than oldest-first. Trim to COHORT_LOOKBACK_MONTHS so the page
  /// stays bounded.
  const monthNamesShort = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const sortedCohortKeys = Array.from(cohortMap.keys()).sort().reverse().slice(0, COHORT_LOOKBACK_MONTHS);
  /// We want oldest → newest in the final array so the table reads
  /// top-down chronologically (Jan, Feb, Mar...). Reverse the slice.
  sortedCohortKeys.reverse();
  const now = new Date();
  const cohorts = sortedCohortKeys.map((key) => {
    const [yearStr, monthStr] = key.split('-');
    const yearNum = Number(yearStr);
    const monthIdx0 = Number(monthStr) - 1;
    const cohort = cohortMap.get(key);
    const size = cohort.customers.size;
    /// How many months back from now is this cohort's start? Caps
    /// the retention array so we don't show "M5" for a cohort that
    /// only just started 2 months ago — those cells would be all
    /// nulls / zeros, which looks like churn rather than "data not
    /// yet available".
    const cohortStart = new Date(yearNum, monthIdx0, 1);
    const monthsElapsed =
      (now.getFullYear() - cohortStart.getFullYear()) * 12 +
      (now.getMonth() - cohortStart.getMonth());
    const horizon = Math.min(COHORT_LOOKBACK_MONTHS, monthsElapsed + 1);
    const retention = [];
    for (let m = 0; m < horizon; m++) {
      let active = 0;
      for (const cid of cohort.customers) {
        if (cohort.activity.get(cid)?.has(m)) active += 1;
      }
      retention.push(size > 0 ? Math.round((active / size) * 100) : 0);
    }
    return {
      cohort: `${monthNamesShort[monthIdx0]} ${yearNum}`,
      size,
      retention,
    };
  });

  // Churn risk — customers with no bookings in last 60 days.
  const sixtyAgo = new Date(); sixtyAgo.setDate(sixtyAgo.getDate() - 60);
  const recentBookers = new Set(
    (await prisma.booking.findMany({
      where: withCityScope({ createdAt: { gte: sixtyAgo } }, scope),
      select: { customerId: true },
    })).map((b) => b.customerId),
  );
  const allActive = await prisma.customer.count({ where: withCustomerScope({ isActive: true }, scope) });
  const churnRiskCount = Math.max(0, allActive - recentBookers.size);

  return {
    newRegistrations,
    repeatRate: Math.round(repeatRate * 100) / 100,
    avgFrequency: Math.round(avgFrequency * 10) / 10,
    cohorts,
    churnRiskCount,
  };
};
