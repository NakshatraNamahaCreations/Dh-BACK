const prisma = require('../../config/prisma');

const shape = (i) => ({
  id: i.id,
  phone: i.phone,
  city: i.city,
  pincode: i.pincode,
  source: i.source,
  notified: i.notified,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

/// Captures a "notify me when you launch here" submission. Idempotent on
/// (phone, city) — re-submitting just bumps updatedAt and refreshes pincode.
exports.capture = async ({ phone, city, pincode, source }) => {
  const item = await prisma.launchInterest.upsert({
    where: { phone_city: { phone, city } },
    create: {
      phone,
      city,
      pincode: pincode ?? null,
      source: source ?? 'coming_soon',
    },
    update: {
      pincode: pincode ?? null,
      source: source ?? 'coming_soon',
    },
  });
  return shape(item);
};

/// Admin demand view — top cities by request count, optionally drilled into a
/// city to see pincode breakdown + recent submissions.
exports.summary = async ({ city, limit = 50 } = {}) => {
  if (!city) {
    // City-level rollup.
    const grouped = await prisma.launchInterest.groupBy({
      by: ['city'],
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { _count: { phone: 'desc' } },
      take: limit,
    });
    const totals = grouped.map((g) => ({
      city: g.city,
      count: g._count._all,
      latestAt: g._max.createdAt,
    }));
    const total = await prisma.launchInterest.count();
    return { mode: 'cities', total, rows: totals };
  }

  // Drill into one city — pincode breakdown + recent submissions.
  const pincodeRollup = await prisma.launchInterest.groupBy({
    by: ['pincode'],
    where: { city: { equals: city, mode: 'insensitive' } },
    _count: { _all: true },
    _max: { createdAt: true },
    orderBy: { _count: { phone: 'desc' } },
  });
  const recent = await prisma.launchInterest.findMany({
    where: { city: { equals: city, mode: 'insensitive' } },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  const total = recent.length === 0
    ? 0
    : pincodeRollup.reduce((s, p) => s + p._count._all, 0);

  return {
    mode: 'city',
    city,
    total,
    pincodes: pincodeRollup.map((p) => ({
      pincode: p.pincode,
      count: p._count._all,
      latestAt: p._max.createdAt,
    })),
    recent: recent.map(shape),
  };
};
