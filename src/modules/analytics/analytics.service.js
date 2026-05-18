const prisma = require('../../config/prisma');

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

// ── Dashboard summary ──────────────────────────────────────────────────────

exports.summary = async () => {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  const [todayBookings, yesterdayBookings, activePartners] = await Promise.all([
    prisma.booking.findMany({
      where: { createdAt: { gte: todayStart } },
      select: { total: true, status: true },
    }),
    prisma.booking.findMany({
      where: { createdAt: { gte: yesterdayStart, lt: todayStart } },
      select: { total: true },
    }),
    prisma.partner.count({ where: { isActive: true } }),
  ]);

  const todayRevenue = todayBookings
    .filter((b) => b.status !== 'CANCELLED')
    .reduce((s, b) => s + b.total, 0);
  const yesterdayRevenue = yesterdayBookings.reduce((s, b) => s + b.total, 0);
  const todayJobs = todayBookings.filter((b) => b.status !== 'CANCELLED').length;
  const yesterdayJobs = yesterdayBookings.length;

  const pct = (curr, prev) => (prev > 0 ? ((curr - prev) / prev) * 100 : curr > 0 ? 100 : 0);

  // Pending payouts — sum of completed bookings not yet "paid out". Since we
  // don't have a payouts table yet, approximate as sum of completed bookings
  // in the last 7 days at 75% of total (rough partner share).
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCompleted = await prisma.booking.aggregate({
    where: { status: 'COMPLETED', updatedAt: { gte: sevenDaysAgo } },
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

exports.revenueSeries = async ({ range = '7d' } = {}) => {
  const { from, days } = dateFromRange(range);

  const bookings = await prisma.booking.findMany({
    where: { createdAt: { gte: from }, status: { not: 'CANCELLED' } },
    select: { total: true, createdAt: true },
  });

  // Group by ISO date.
  const buckets = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { day: fmtDay(d), revenue: 0, jobs: 0 });
  }
  for (const b of bookings) {
    const key = b.createdAt.toISOString().slice(0, 10);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.revenue += b.total;
      bucket.jobs += 1;
    }
  }
  return Array.from(buckets.values());
};

// ── Booking analytics ──────────────────────────────────────────────────────

exports.bookingAnalytics = async ({ range = '7d' } = {}) => {
  const { from } = dateFromRange(range);

  const bookings = await prisma.booking.findMany({
    where: { createdAt: { gte: from } },
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
    const area = line.split(',')[0]?.trim() || city || 'Unknown';
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
    for (const it of b.items) {
      const cat = it.service?.category?.name ?? 'Other';
      const e = byCatMap.get(cat) ?? { jobs: 0, revenue: 0 };
      e.jobs += 1;
      e.revenue += it.basePrice * it.qty;
      byCatMap.set(cat, e);
    }
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

exports.revenueReport = async ({ range = '30d' } = {}) => {
  const { from } = dateFromRange(range);
  const series = await exports.revenueSeries({ range });

  const bookings = await prisma.booking.findMany({
    where: { createdAt: { gte: from } },
    include: {
      items: {
        include: { service: { include: { category: { select: { name: true } } } } },
      },
    },
  });

  const completed = bookings.filter((b) => b.status === 'COMPLETED');
  const cancelled = bookings.filter((b) => b.status === 'CANCELLED');

  const gmv = completed.reduce((s, b) => s + b.total, 0);
  // Default 20% commission across the board until Setting-driven.
  const commission = Math.round(gmv * 0.2);
  const payout = gmv - commission;
  const refunds = cancelled.reduce((s, b) => s + b.total, 0);

  // By category.
  const byCatMap = new Map();
  for (const b of completed) {
    for (const it of b.items) {
      const cat = it.service?.category?.name ?? 'Other';
      const e = byCatMap.get(cat) ?? { gmv: 0, commission: 0, payout: 0 };
      const lineGmv = it.basePrice * it.qty;
      e.gmv += lineGmv;
      e.commission += Math.round(lineGmv * 0.2);
      e.payout += lineGmv - Math.round(lineGmv * 0.2);
      byCatMap.set(cat, e);
    }
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

// ── Partner performance ────────────────────────────────────────────────────

exports.partnerPerformance = async ({ range = '30d' } = {}) => {
  const { from, days } = dateFromRange(range);
  const priorFrom = new Date(from.getTime() - days * 24 * 60 * 60 * 1000);

  const partners = await prisma.partner.findMany({
    where: { isActive: true },
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

exports.customerInsights = async ({ range = '90d' } = {}) => {
  const { from, days } = dateFromRange(range);

  const customers = await prisma.customer.findMany({
    where: { createdAt: { gte: from } },
    select: { id: true, createdAt: true },
  });
  const allBookings = await prisma.booking.findMany({
    where: { createdAt: { gte: from } },
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
      where: { createdAt: { gte: sixtyAgo } },
      select: { customerId: true },
    })).map((b) => b.customerId),
  );
  const allActive = await prisma.customer.count({ where: { isActive: true } });
  const churnRiskCount = Math.max(0, allActive - recentBookers.size);

  return {
    newRegistrations,
    repeatRate: Math.round(repeatRate * 100) / 100,
    avgFrequency: Math.round(avgFrequency * 10) / 10,
    cohorts,
    churnRiskCount,
  };
};
