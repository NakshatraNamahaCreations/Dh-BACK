const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

// ── Suggested ranges (per category, percentages) ───────────────────────────

/// Default percentages used when a category has no admin-saved range yet.
/// Picked to give a usable slider out of the box: -30% to +25%, recommended
/// price equal to the service basePrice.
const DEFAULT_PCT = { minPct: 70, midPct: 100, maxPct: 125 };

const applyPct = (basePrice, pct) => Math.max(0, Math.round((basePrice * pct) / 100));

const shapeCategoryRow = (cat, range) => {
  const p = range ?? DEFAULT_PCT;
  return {
    categoryId: cat.id,
    categoryName: cat.name,
    icon: cat.icon,
    color: cat.color,
    serviceCount: cat._count?.services ?? 0,
    minPct: p.minPct,
    midPct: p.midPct,
    maxPct: p.maxPct,
    /// Convenience for the admin UI — shows what these percentages produce
    /// against the cheapest and most expensive service in the category.
    sample: cat.services && cat.services.length > 0 ? {
      lowest: shapeSample(cat.services[0], p),
      highest: shapeSample(cat.services[cat.services.length - 1], p),
    } : null,
    updatedAt: range?.updatedAt ?? null,
  };
};

const shapeSample = (svc, pct) => ({
  serviceName: svc.name,
  basePrice: svc.basePrice,
  min: applyPct(svc.basePrice, pct.minPct),
  mid: applyPct(svc.basePrice, pct.midPct),
  max: applyPct(svc.basePrice, pct.maxPct),
});

exports.listRanges = async () => {
  const categories = await prisma.category.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
    include: {
      _count: { select: { services: { where: { active: true } } } },
      services: {
        where: { active: true },
        orderBy: { basePrice: 'asc' },
        select: { id: true, name: true, basePrice: true },
      },
    },
  });

  const categoryIds = categories.map((c) => c.id);
  const ranges = await prisma.categoryRange.findMany({
    where: { categoryId: { in: categoryIds } },
  });
  const rangeBy = new Map(ranges.map((r) => [r.categoryId, r]));

  return categories.map((c) => shapeCategoryRow(c, rangeBy.get(c.id)));
};

exports.saveRanges = async (rows) => {
  // Validate — categories must exist and 0 ≤ minPct ≤ midPct ≤ maxPct.
  const ids = rows.map((r) => r.categoryId);
  const categories = await prisma.category.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  });
  const knownIds = new Set(categories.map((c) => c.id));
  const missing = ids.filter((id) => !knownIds.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(`Unknown category ids: ${missing.join(', ')}`);
  }
  for (const r of rows) {
    if (r.minPct > r.midPct || r.midPct > r.maxPct) {
      throw ApiError.badRequest(
        `Invalid range for category ${r.categoryId}: must satisfy minPct ≤ midPct ≤ maxPct`,
      );
    }
  }

  await prisma.$transaction(
    rows.map((r) =>
      prisma.categoryRange.upsert({
        where: { categoryId: r.categoryId },
        create: {
          categoryId: r.categoryId,
          minPct: r.minPct,
          midPct: r.midPct,
          maxPct: r.maxPct,
        },
        update: { minPct: r.minPct, midPct: r.midPct, maxPct: r.maxPct },
      }),
    ),
  );

  return exports.listRanges();
};

// ── Surge match ────────────────────────────────────────────────────────────

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const minutesOfDay = (date) => date.getHours() * 60 + date.getMinutes();
const parseHHmm = (s) => {
  const [h, m] = String(s).split(':').map((n) => parseInt(n, 10));
  return h * 60 + m;
};

/// Returns the highest-multiplier active surge rule that matches the given
/// (city, pincode, when, optional categoryIds) signal, or null if no match.
/// Rules with categoryId=null match any category.
const findApplicableSurge = async ({ city, pincode, when, categoryIds }) => {
  if (!city) return null;

  const area = await prisma.serviceArea.findFirst({
    where: { city: { equals: city, mode: 'insensitive' }, active: true },
    select: { id: true, city: true },
  });
  if (!area) return null;

  // Pull every active rule on this area; filter day/time/pincode/category in JS.
  const rules = await prisma.surgeRule.findMany({
    where: { serviceAreaId: area.id, active: true },
  });

  const dayKey = DAY_KEYS[when.getDay()];
  const minuteOfDay = minutesOfDay(when);
  const pin = String(pincode ?? '').trim();
  const cartCategoryIds = new Set(categoryIds ?? []);

  const matches = rules.filter((r) => {
    if (!r.days.includes(dayKey)) return false;
    const start = parseHHmm(r.startTime);
    const end = parseHHmm(r.endTime);
    // Overnight windows (e.g. 22:00 → 02:00) wrap past midnight.
    const inWindow = start <= end
      ? minuteOfDay >= start && minuteOfDay <= end
      : minuteOfDay >= start || minuteOfDay <= end;
    if (!inWindow) return false;
    if (r.pincodes.length > 0 && !r.pincodes.includes(pin)) return false;
    if (r.categoryId !== null && cartCategoryIds.size > 0 && !cartCategoryIds.has(r.categoryId)) {
      return false;
    }
    return true;
  });

  if (matches.length === 0) return null;

  // Highest multiplier wins — ties broken by most recently updated.
  matches.sort((a, b) => {
    if (b.multiplier !== a.multiplier) return b.multiplier - a.multiplier;
    return b.updatedAt - a.updatedAt;
  });
  const top = matches[0];
  return {
    ruleId: top.id,
    ruleName: top.name,
    multiplier: top.multiplier,
    categoryId: top.categoryId,
    serviceArea: { id: area.id, city: area.city },
  };
};

/// Exported for booking creation — the SAME rule engine the cart quote
/// uses, so the price shown in the cart and the price snapshotted on
/// the booking can never disagree.
exports.findApplicableSurge = findApplicableSurge;

// ── Cart quote (used by customer app) ──────────────────────────────────────
//
// Looks up each line's service + its category's range, applies the
// percentages to the service's basePrice, optionally applies a surge
// multiplier, and sums into cart-level totals.
exports.quoteRange = async ({ items, city, pincode, at }) => {
  const ids = [...new Set(items.map((i) => i.serviceId))];
  const services = await prisma.service.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, basePrice: true, categoryId: true },
  });
  const svcById = new Map(services.map((s) => [s.id, s]));

  const missing = ids.filter((id) => !svcById.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(`Unknown service ids: ${missing.join(', ')}`);
  }

  const categoryIds = [...new Set(services.map((s) => s.categoryId))];
  const ranges = await prisma.categoryRange.findMany({
    where: { categoryId: { in: categoryIds } },
  });
  const pctBy = new Map(ranges.map((r) => [r.categoryId, r]));

  const when = at ? new Date(at) : new Date();
  const surge = await findApplicableSurge({ city, pincode, when, categoryIds });
  const mult = surge?.multiplier ?? 1;

  const lines = items.map((it) => {
    const svc = svcById.get(it.serviceId);
    const pct = pctBy.get(svc.categoryId) ?? DEFAULT_PCT;
    // Surge applies only to lines whose category matches (or rule is global).
    const lineSurged = !surge ? false
      : surge.categoryId === null || surge.categoryId === svc.categoryId;
    const m = lineSurged ? mult : 1;
    return {
      serviceId: svc.id,
      serviceName: svc.name,
      qty: it.qty,
      basePrice: Math.round(svc.basePrice * m),
      min: Math.round(applyPct(svc.basePrice, pct.minPct) * m),
      mid: Math.round(applyPct(svc.basePrice, pct.midPct) * m),
      max: Math.round(applyPct(svc.basePrice, pct.maxPct) * m),
      surged: lineSurged,
    };
  });

  const totals = lines.reduce(
    (acc, l) => ({
      basePrice: acc.basePrice + l.basePrice * l.qty,
      min: acc.min + l.min * l.qty,
      mid: acc.mid + l.mid * l.qty,
      max: acc.max + l.max * l.qty,
    }),
    { basePrice: 0, min: 0, mid: 0, max: 0 },
  );

  return { ...totals, lines, surge: surge ?? null };
};

// ── Surge rules ─────────────────────────────────────────────────────────────

const shapeSurge = (s) => ({
  id: s.id,
  name: s.name,
  categoryId: s.categoryId,
  serviceAreaId: s.serviceAreaId,
  serviceArea: s.serviceArea
    ? { id: s.serviceArea.id, city: s.serviceArea.city, pincodes: s.serviceArea.pincodes }
    : null,
  pincodes: s.pincodes,
  days: s.days,
  startTime: s.startTime,
  endTime: s.endTime,
  multiplier: s.multiplier,
  active: s.active,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const validateRulePincodes = (rulePincodes, area) => {
  if (!rulePincodes || rulePincodes.length === 0) return [];
  // If the area itself is pincode-restricted, the rule's pincodes must be a
  // subset of the area's pincode list — otherwise the rule references
  // pincodes the area doesn't even cover.
  if (area.pincodes.length > 0) {
    const allowed = new Set(area.pincodes);
    const stray = rulePincodes.filter((p) => !allowed.has(p));
    if (stray.length > 0) {
      throw ApiError.badRequest(
        `Pincodes not in service area: ${stray.join(', ')}`,
      );
    }
  }
  return [...new Set(rulePincodes.map((p) => String(p).trim()))];
};

exports.listSurge = async () => {
  const items = await prisma.surgeRule.findMany({
    orderBy: { createdAt: 'asc' },
    include: { serviceArea: { select: { id: true, city: true, pincodes: true } } },
  });
  return items.map(shapeSurge);
};

exports.createSurge = async (data) => {
  const area = await prisma.serviceArea.findUnique({
    where: { id: data.serviceAreaId },
    select: { id: true, pincodes: true },
  });
  if (!area) throw ApiError.badRequest('Service area not found');
  const pincodes = validateRulePincodes(data.pincodes ?? [], area);

  const item = await prisma.surgeRule.create({
    data: {
      name: data.name,
      categoryId: data.categoryId,
      serviceAreaId: data.serviceAreaId,
      pincodes,
      days: data.days,
      startTime: data.startTime,
      endTime: data.endTime,
      multiplier: data.multiplier,
      active: data.active ?? true,
    },
    include: { serviceArea: { select: { id: true, city: true, pincodes: true } } },
  });
  return shapeSurge(item);
};

exports.updateSurge = async (id, data) => {
  // If pincodes are being updated, we need to know the area to validate
  // against. Resolve the target area: either the new one being set, or the
  // existing one on the rule.
  let area = null;
  if (data.pincodes !== undefined) {
    const targetAreaId = data.serviceAreaId ?? (
      await prisma.surgeRule.findUnique({ where: { id }, select: { serviceAreaId: true } })
    )?.serviceAreaId;
    if (targetAreaId) {
      area = await prisma.serviceArea.findUnique({
        where: { id: targetAreaId },
        select: { id: true, pincodes: true },
      });
      if (!area) throw ApiError.badRequest('Service area not found');
    }
  } else if (data.serviceAreaId !== undefined) {
    // Area is being changed without explicit pincode change — verify it exists.
    area = await prisma.serviceArea.findUnique({
      where: { id: data.serviceAreaId },
      select: { id: true, pincodes: true },
    });
    if (!area) throw ApiError.badRequest('Service area not found');
  }

  const patch = { ...data };
  if (patch.pincodes !== undefined && area) {
    patch.pincodes = validateRulePincodes(patch.pincodes, area);
  }

  try {
    const item = await prisma.surgeRule.update({
      where: { id },
      data: patch,
      include: { serviceArea: { select: { id: true, city: true, pincodes: true } } },
    });
    return shapeSurge(item);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Surge rule not found');
    throw err;
  }
};

exports.toggleSurge = async (id) => {
  const current = await prisma.surgeRule.findUnique({ where: { id }, select: { active: true } });
  if (!current) throw ApiError.notFound('Surge rule not found');
  const item = await prisma.surgeRule.update({
    where: { id },
    data: { active: !current.active },
    include: { serviceArea: { select: { id: true, city: true, pincodes: true } } },
  });
  return shapeSurge(item);
};

exports.removeSurge = async (id) => {
  try {
    await prisma.surgeRule.delete({ where: { id } });
    return { id };
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Surge rule not found');
    throw err;
  }
};
