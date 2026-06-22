const prisma = require('../../config/prisma');
const cache = require('../../lib/cache');
const ApiError = require('../../utils/ApiError');

const SERVICE_INCLUDE = {
  category: { select: { id: true, name: true, icon: true, color: true } },
  subCategory: { select: { id: true, name: true, icon: true } },
  faqs: { orderBy: { sortOrder: 'asc' } },
};

const CACHE_PREFIX = 'svc:';
/// Service catalog changes more often than categories (price tweaks,
/// new offerings) but most reads are still on stable data. 5 minutes
/// keeps customer-app browsing snappy without holding stale prices
/// for long.
const CACHE_TTL = 300;

const listKey = ({ page, pageSize, search, categoryId, subCategoryId, active } = {}) =>
  `${CACHE_PREFIX}list:p${page}:ps${pageSize}:c${categoryId ?? ''}:s${subCategoryId ?? ''}:a${active === true ? '1' : active === false ? '0' : 'N'}:q${search ?? ''}`;
const itemKey = (id) => `${CACHE_PREFIX}id:${id}`;
const relatedKey = (id, limit) => `${CACHE_PREFIX}rel:${id}:l${limit}`;

/// Wipe every cached read for this module AND categories — a service
/// write changes the `serviceCount` on its category, which is part of
/// the cached category payload.
const invalidate = async () => {
  await Promise.all([
    cache.delByPrefix(CACHE_PREFIX),
    cache.delByPrefix('cat:'),
    /// A service's `subCategoryId` drives each sub-category's `serviceCount`,
    /// so creating / reassigning / deleting a service must also refresh the
    /// sub-category list (otherwise it shows a stale "0" count).
    cache.delByPrefix('subcat:'),
  ]);
};

const shape = (s) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  imageUrl: s.imageUrl,
  thumbnailUrl: s.thumbnailUrl ?? null,
  durationMins: s.durationMins,
  basePrice: s.basePrice,
  originalPrice: s.originalPrice,
  active: s.active,
  includes: s.includes,
  excludes: s.excludes,
  categoryId: s.categoryId,
  category: s.category ?? null,
  /// Optional sub-category. Null = service is attached directly to the
  /// category (renders under "Other Services" in the customer app).
  subCategoryId: s.subCategoryId ?? null,
  subCategory: s.subCategory ?? null,
  faqs: s.faqs?.map((f) => ({
    id: f.id,
    question: f.question,
    answer: f.answer,
    sortOrder: f.sortOrder,
  })) ?? [],
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const assertCategoryExists = async (categoryId) => {
  const exists = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!exists) throw ApiError.badRequest(`Category ${categoryId} does not exist`);
};

/// Validation rule: a chosen sub-category must exist AND belong to the
/// service's category. `categoryId` is the effective category the service
/// will have after this write.
const assertSubCategoryValid = async (subCategoryId, categoryId) => {
  if (subCategoryId == null) return;
  const sub = await prisma.subCategory.findUnique({
    where: { id: subCategoryId },
    select: { id: true, categoryId: true },
  });
  if (!sub) throw ApiError.badRequest(`Sub-category ${subCategoryId} does not exist`);
  if (sub.categoryId !== categoryId) {
    throw ApiError.badRequest('Selected sub-category does not belong to the chosen category');
  }
};

/// Wipes the service's FAQs and recreates them from the supplied array. Runs
/// inside the caller's transaction when one is provided so save is atomic.
const replaceFaqs = async (tx, serviceId, faqs) => {
  await tx.serviceFaq.deleteMany({ where: { serviceId } });
  if (faqs.length === 0) return;
  await tx.serviceFaq.createMany({
    data: faqs.map((f, i) => ({
      serviceId,
      question: f.question.trim(),
      answer: f.answer.trim(),
      sortOrder: i,
    })),
  });
};

exports.list = async ({ page, pageSize, search, categoryId, subCategoryId, active } = {}) => {
  return cache.getOrSet(
    listKey({ page, pageSize, search, categoryId, subCategoryId, active }),
    CACHE_TTL,
    async () => {
      const where = {};
      if (categoryId) where.categoryId = categoryId;
      if (subCategoryId) where.subCategoryId = subCategoryId;
      if (typeof active === 'boolean') where.active = active;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ];
      }

      const skip = (page - 1) * pageSize;
      const [items, total] = await prisma.$transaction([
        prisma.service.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip,
          take: pageSize,
          include: SERVICE_INCLUDE,
        }),
        prisma.service.count({ where }),
      ]);

      return {
        items: items.map(shape),
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      };
    },
  );
};

exports.get = async (id) => {
  return cache.getOrSet(itemKey(id), CACHE_TTL, async () => {
    const s = await prisma.service.findUnique({ where: { id }, include: SERVICE_INCLUDE });
    if (!s) throw ApiError.notFound('Service not found');
    return shape(s);
  });
};

exports.create = async (data) => {
  await assertCategoryExists(data.categoryId);
  await assertSubCategoryValid(data.subCategoryId, data.categoryId);
  const { faqs = [], ...serviceData } = data;
  const created = await prisma.$transaction(async (tx) => {
    const s = await tx.service.create({ data: serviceData });
    if (faqs.length > 0) await replaceFaqs(tx, s.id, faqs);
    return tx.service.findUnique({ where: { id: s.id }, include: SERVICE_INCLUDE });
  });
  await invalidate();
  return shape(created);
};

exports.update = async (id, data) => {
  if (data.categoryId) await assertCategoryExists(data.categoryId);

  /// Validate the sub-category against the EFFECTIVE category (the new
  /// one if the category is changing, else the current one). Runs when
  /// either field is part of the update so a category change can't strand
  /// a service under a sub-category from a different category.
  if (data.subCategoryId !== undefined || data.categoryId !== undefined) {
    const current = await prisma.service.findUnique({
      where: { id },
      select: { categoryId: true, subCategoryId: true },
    });
    if (!current) throw ApiError.notFound('Service not found');
    const effectiveCategoryId = data.categoryId ?? current.categoryId;
    const effectiveSubCategoryId =
      data.subCategoryId !== undefined ? data.subCategoryId : current.subCategoryId;
    await assertSubCategoryValid(effectiveSubCategoryId, effectiveCategoryId);
  }

  // Pricing cross-field validation when one of the two changes.
  if (data.originalPrice != null || data.basePrice != null) {
    const current = await prisma.service.findUnique({
      where: { id },
      select: { basePrice: true, originalPrice: true },
    });
    if (!current) throw ApiError.notFound('Service not found');
    const nextBase = data.basePrice ?? current.basePrice;
    const nextOriginal = data.originalPrice === undefined ? current.originalPrice : data.originalPrice;
    if (nextOriginal != null && nextOriginal <= nextBase) {
      throw ApiError.badRequest('originalPrice must be greater than basePrice');
    }
  }

  const { faqs, ...serviceData } = data;
  const updated = await prisma.$transaction(async (tx) => {
    const s = await tx.service.update({ where: { id }, data: serviceData });
    if (faqs !== undefined) await replaceFaqs(tx, s.id, faqs);
    return tx.service.findUnique({ where: { id: s.id }, include: SERVICE_INCLUDE });
  });
  await invalidate();
  return shape(updated);
};

exports.remove = async (id) => {
  await prisma.service.delete({ where: { id } });
  await invalidate();
  return { id };
};

exports.toggleActive = async (id) => {
  const current = await prisma.service.findUnique({ where: { id }, select: { active: true } });
  if (!current) throw ApiError.notFound('Service not found');
  const s = await prisma.service.update({
    where: { id },
    data: { active: !current.active },
    include: SERVICE_INCLUDE,
  });
  await invalidate();
  return shape(s);
};

exports.bulkImport = async (rows) => {
  // Validate every categoryId up front so we don't half-import then bomb.
  const categoryIds = Array.from(new Set(rows.map((r) => r.categoryId)));
  const found = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true },
  });
  const foundIds = new Set(found.map((c) => c.id));
  const missing = categoryIds.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(`Unknown categoryIds in import: ${missing.join(', ')}`);
  }

  const created = await prisma.$transaction(
    rows.map((row) =>
      prisma.service.create({ data: row, include: SERVICE_INCLUDE }),
    ),
  );

  await invalidate();
  return {
    inserted: created.length,
    items: created.map(shape),
  };
};

// ── Related services ──────────────────────────────────────────────────────
//
// Surfaces a "Frequently added with this" + "Other services in this category"
// strip on the customer service detail screen. Resolution order:
//
//   1. Find services that appear most often in the SAME bookings as the
//      target service (co-occurrence) — labelled 'frequently_booked'.
//   2. If there aren't enough to fill the limit, pad with other active
//      services in the same category — labelled 'same_category'.
exports.getRelated = async (id, { limit = 6 } = {}) => {
  return cache.getOrSet(relatedKey(id, limit), CACHE_TTL, async () => {
    return computeRelated(id, limit);
  });
};

async function computeRelated(id, limit) {
  const target = await prisma.service.findUnique({
    where: { id },
    select: { id: true, categoryId: true },
  });
  if (!target) throw ApiError.notFound('Service not found');

  // Step 1 — co-occurrence: bookings containing the target, then count every
  // other service that appeared in those same bookings.
  const bookingsWithTarget = await prisma.bookingItem.findMany({
    where: { serviceId: id },
    select: { bookingId: true },
  });
  const bookingIds = bookingsWithTarget.map((b) => b.bookingId);

  const coOccurrenceCounts = new Map(); // serviceId -> count
  if (bookingIds.length > 0) {
    const coItems = await prisma.bookingItem.findMany({
      where: { bookingId: { in: bookingIds }, serviceId: { not: id } },
      select: { serviceId: true },
    });
    for (const it of coItems) {
      coOccurrenceCounts.set(it.serviceId, (coOccurrenceCounts.get(it.serviceId) ?? 0) + 1);
    }
  }

  const coOccurrenceIds = [...coOccurrenceCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([sid]) => sid)
    .slice(0, limit);

  // Step 2 — fill the rest from same-category active services.
  const need = limit - coOccurrenceIds.length;
  let fallbackIds = [];
  if (need > 0) {
    const fallbacks = await prisma.service.findMany({
      where: {
        categoryId: target.categoryId,
        active: true,
        id: { notIn: [id, ...coOccurrenceIds] },
      },
      orderBy: [{ basePrice: 'asc' }, { createdAt: 'desc' }],
      take: need,
      select: { id: true },
    });
    fallbackIds = fallbacks.map((s) => s.id);
  }

  const orderedIds = [...coOccurrenceIds, ...fallbackIds];
  if (orderedIds.length === 0) return [];

  // Final fetch — preserve the order we computed.
  const services = await prisma.service.findMany({
    where: { id: { in: orderedIds }, active: true },
    include: SERVICE_INCLUDE,
  });
  const byId = new Map(services.map((s) => [s.id, s]));

  return orderedIds
    .map((sid) => byId.get(sid))
    .filter(Boolean)
    .map((s) => ({
      ...shape(s),
      reason: coOccurrenceCounts.has(s.id) ? 'frequently_booked' : 'same_category',
      coOccurrenceCount: coOccurrenceCounts.get(s.id) ?? 0,
    }));
}
