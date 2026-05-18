const prisma = require('../../config/prisma');
const cache = require('../../lib/cache');
const ApiError = require('../../utils/ApiError');

const CATEGORY_INCLUDE = {
  _count: { select: { services: true } },
};

const CACHE_PREFIX = 'cat:';
/// Categories rarely change but are read on every customer-app home
/// load. 10 minutes is a comfortable middle-ground: long enough that
/// a steady-state app rarely re-queries the DB, short enough that
/// even an admin who forgets to trigger a write-driven invalidate
/// (e.g. via a direct DB tweak) sees their change soon enough.
const CACHE_TTL = 600;

const listKey = ({ active, search } = {}) =>
  `${CACHE_PREFIX}list:${active === true ? 'a1' : active === false ? 'a0' : 'aN'}:${search ?? ''}`;
const itemKey = (id) => `${CACHE_PREFIX}id:${id}`;

/// Wipe every cached read for this module AND every cached service
/// payload, since a category change (icon, name, color) ripples into
/// the `category` snapshot embedded on each Service.
const invalidate = async () => {
  await Promise.all([
    cache.delByPrefix(CACHE_PREFIX),
    cache.delByPrefix('svc:'),
  ]);
};

const shape = (cat) => ({
  id: cat.id,
  name: cat.name,
  icon: cat.icon,
  color: cat.color,
  active: cat.active,
  sortOrder: cat.sortOrder,
  serviceCount: cat._count?.services ?? 0,
  bannerImageUrl: cat.bannerImageUrl,
  offerHeadline: cat.offerHeadline,
  offerSubtext: cat.offerSubtext,
  offerPrice: cat.offerPrice,
  createdAt: cat.createdAt,
  updatedAt: cat.updatedAt,
});

exports.list = async ({ active, search } = {}) => {
  return cache.getOrSet(listKey({ active, search }), CACHE_TTL, async () => {
    const where = {};
    if (typeof active === 'boolean') where.active = active;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const items = await prisma.category.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: CATEGORY_INCLUDE,
    });
    return items.map(shape);
  });
};

exports.get = async (id) => {
  return cache.getOrSet(itemKey(id), CACHE_TTL, async () => {
    const cat = await prisma.category.findUnique({
      where: { id },
      include: CATEGORY_INCLUDE,
    });
    if (!cat) throw ApiError.notFound('Category not found');
    return shape(cat);
  });
};

exports.create = async (data) => {
  // Auto-assign sortOrder to end of list if not provided.
  let sortOrder = data.sortOrder;
  if (sortOrder == null) {
    const last = await prisma.category.findFirst({
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    sortOrder = (last?.sortOrder ?? 0) + 1;
  }
  const cat = await prisma.category.create({
    data: { ...data, sortOrder },
    include: CATEGORY_INCLUDE,
  });
  await invalidate();
  return shape(cat);
};

exports.update = async (id, data) => {
  const cat = await prisma.category.update({
    where: { id },
    data,
    include: CATEGORY_INCLUDE,
  });
  await invalidate();
  return shape(cat);
};

exports.remove = async (id) => {
  // Reject if any services still reference this category.
  const linked = await prisma.service.count({ where: { categoryId: id } });
  if (linked > 0) {
    throw ApiError.conflict(
      `Cannot delete — ${linked} service${linked === 1 ? ' is' : 's are'} still linked. Move or delete them first.`,
    );
  }
  await prisma.category.delete({ where: { id } });
  await invalidate();
  return { id };
};

exports.toggleActive = async (id) => {
  const current = await prisma.category.findUnique({ where: { id }, select: { active: true } });
  if (!current) throw ApiError.notFound('Category not found');
  const updated = await prisma.category.update({
    where: { id },
    data: { active: !current.active },
    include: CATEGORY_INCLUDE,
  });
  await invalidate();
  return shape(updated);
};

exports.reorder = async (orderedIds) => {
  // Verify every id exists and exactly matches the live category set.
  const existing = await prisma.category.findMany({ select: { id: true } });
  const existingIds = new Set(existing.map((c) => c.id));
  const seen = new Set();
  for (const id of orderedIds) {
    if (!existingIds.has(id)) throw ApiError.badRequest(`Unknown category id: ${id}`);
    if (seen.has(id)) throw ApiError.badRequest(`Duplicate id in order: ${id}`);
    seen.add(id);
  }
  if (orderedIds.length !== existing.length) {
    throw ApiError.badRequest('Order list must contain every category id exactly once');
  }

  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.category.update({ where: { id }, data: { sortOrder: i + 1 } }),
    ),
  );
  /// Invalidate BEFORE re-listing so the next list() call returns
  /// fresh data instead of the stale pre-reorder snapshot.
  await invalidate();
  return exports.list();
};
