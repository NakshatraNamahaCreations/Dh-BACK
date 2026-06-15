const prisma = require('../../config/prisma');
const cache = require('../../lib/cache');
const ApiError = require('../../utils/ApiError');

const SUBCAT_INCLUDE = {
  _count: { select: { services: true } },
  category: { select: { id: true, name: true } },
};

const CACHE_PREFIX = 'subcat:';
const CACHE_TTL = 600;

const listKey = ({ categoryId, active, search } = {}) =>
  `${CACHE_PREFIX}list:c${categoryId ?? 'N'}:${active === true ? 'a1' : active === false ? 'a0' : 'aN'}:${search ?? ''}`;
const itemKey = (id) => `${CACHE_PREFIX}id:${id}`;

/// A sub-category change ripples into the embedded `subCategory` snapshot
/// on services and the customer-app grouped category view, so wipe the
/// service + category caches alongside this module's own.
const invalidate = async () => {
  await Promise.all([
    cache.delByPrefix(CACHE_PREFIX),
    cache.delByPrefix('svc:'),
    cache.delByPrefix('cat:'),
  ]);
};

const shape = (sc) => ({
  id: sc.id,
  name: sc.name,
  icon: sc.icon,
  bannerImageUrl: sc.bannerImageUrl,
  active: sc.active,
  sortOrder: sc.sortOrder,
  categoryId: sc.categoryId,
  categoryName: sc.category?.name ?? null,
  serviceCount: sc._count?.services ?? 0,
  createdAt: sc.createdAt,
  updatedAt: sc.updatedAt,
});

/// Confirm a parent category exists before linking a sub-category to it
/// — enforces "a sub-category cannot exist without a parent category".
const assertCategoryExists = async (categoryId) => {
  const cat = await prisma.category.findUnique({ where: { id: categoryId }, select: { id: true } });
  if (!cat) throw ApiError.badRequest('Parent category does not exist');
};

exports.list = async ({ categoryId, active, search } = {}) => {
  return cache.getOrSet(listKey({ categoryId, active, search }), CACHE_TTL, async () => {
    const where = {};
    if (categoryId != null) where.categoryId = categoryId;
    if (typeof active === 'boolean') where.active = active;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const items = await prisma.subCategory.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: SUBCAT_INCLUDE,
    });
    return items.map(shape);
  });
};

exports.get = async (id) => {
  return cache.getOrSet(itemKey(id), CACHE_TTL, async () => {
    const sc = await prisma.subCategory.findUnique({
      where: { id },
      include: SUBCAT_INCLUDE,
    });
    if (!sc) throw ApiError.notFound('Sub-category not found');
    return shape(sc);
  });
};

exports.create = async (data) => {
  await assertCategoryExists(data.categoryId);
  // Auto-assign sortOrder to the end of the parent category's list.
  let sortOrder = data.sortOrder;
  if (sortOrder == null) {
    const last = await prisma.subCategory.findFirst({
      where: { categoryId: data.categoryId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    sortOrder = (last?.sortOrder ?? 0) + 1;
  }
  const sc = await prisma.subCategory.create({
    data: { ...data, sortOrder },
    include: SUBCAT_INCLUDE,
  });
  await invalidate();
  return shape(sc);
};

exports.update = async (id, data) => {
  if (data.categoryId != null) await assertCategoryExists(data.categoryId);
  const sc = await prisma.subCategory.update({
    where: { id },
    data,
    include: SUBCAT_INCLUDE,
  });
  await invalidate();
  return shape(sc);
};

exports.remove = async (id) => {
  /// Block deletion while services still reference this sub-category —
  /// the admin must reassign them (to another sub-category or back to
  /// the category directly) first. Matches the Categories guard.
  const linked = await prisma.service.count({ where: { subCategoryId: id } });
  if (linked > 0) {
    throw ApiError.conflict(
      `Cannot delete — ${linked} service${linked === 1 ? ' is' : 's are'} still in this sub-category. Reassign them first.`,
    );
  }
  await prisma.subCategory.delete({ where: { id } });
  await invalidate();
  return { id };
};

exports.toggleActive = async (id) => {
  const current = await prisma.subCategory.findUnique({ where: { id }, select: { active: true } });
  if (!current) throw ApiError.notFound('Sub-category not found');
  const updated = await prisma.subCategory.update({
    where: { id },
    data: { active: !current.active },
    include: SUBCAT_INCLUDE,
  });
  await invalidate();
  return shape(updated);
};

exports.reorder = async (categoryId, orderedIds) => {
  /// Reorder is scoped to a single parent category — verify every id
  /// belongs to it and the list is complete + unique.
  const existing = await prisma.subCategory.findMany({
    where: { categoryId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((s) => s.id));
  const seen = new Set();
  for (const id of orderedIds) {
    if (!existingIds.has(id)) throw ApiError.badRequest(`Unknown sub-category id for this category: ${id}`);
    if (seen.has(id)) throw ApiError.badRequest(`Duplicate id in order: ${id}`);
    seen.add(id);
  }
  if (orderedIds.length !== existing.length) {
    throw ApiError.badRequest('Order list must contain every sub-category id for this category exactly once');
  }

  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.subCategory.update({ where: { id }, data: { sortOrder: i + 1 } }),
    ),
  );
  await invalidate();
  return exports.list({ categoryId });
};
