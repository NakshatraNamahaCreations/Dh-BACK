const prisma = require('../../config/prisma');
const cache = require('../../lib/cache');
const ApiError = require('../../utils/ApiError');

const CACHE_PREFIX = 'banners:';
/// Banners are read on every customer-app home load and change a few
/// times a week at most. 5 minutes balances "promo edits show up
/// reasonably fast" with "we're not querying the DB once per visitor".
/// Note: liveOnly results need to expire faster because schedule
/// boundaries (startsAt/endsAt) tick over in real time — we knock that
/// down to 60s below so a banner that flips live during browsing
/// doesn't take the full TTL to appear.
const CACHE_TTL = 300;
const CACHE_TTL_LIVE_ONLY = 60;

const listKey = ({ placement, active, liveOnly } = {}) =>
  `${CACHE_PREFIX}list:p${placement ?? ''}:a${active === true ? '1' : active === false ? '0' : 'N'}:l${liveOnly ? '1' : '0'}`;
const itemKey = (id) => `${CACHE_PREFIX}id:${id}`;

const invalidate = async () => {
  await cache.delByPrefix(CACHE_PREFIX);
};

const shape = (b) => ({
  id: b.id,
  placement: b.placement,
  imageUrl: b.imageUrl,
  ctaType: b.ctaType,
  ctaValue: b.ctaValue,
  ctaLabel: b.ctaLabel,
  active: b.active,
  sortOrder: b.sortOrder,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

const ifEmptyDropCta = (data) => {
  if (data.ctaType === 'NONE') {
    return { ...data, ctaValue: null, ctaLabel: null };
  }
  return data;
};

exports.list = async ({ placement, active, liveOnly } = {}) => {
  const ttl = liveOnly ? CACHE_TTL_LIVE_ONLY : CACHE_TTL;
  return cache.getOrSet(listKey({ placement, active, liveOnly }), ttl, async () => {
    const where = {};
    if (placement) where.placement = placement;
    if (typeof active === 'boolean') where.active = active;
    if (liveOnly) {
      where.active = true;
      const now = new Date();
      where.AND = [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
      ];
    }
    const items = await prisma.appBanner.findMany({
      where,
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return items.map(shape);
  });
};

exports.get = async (id) => {
  return cache.getOrSet(itemKey(id), CACHE_TTL, async () => {
    const b = await prisma.appBanner.findUnique({ where: { id } });
    if (!b) throw ApiError.notFound('Banner not found');
    return shape(b);
  });
};

exports.create = async (data) => {
  let sortOrder = data.sortOrder;
  if (sortOrder == null) {
    const last = await prisma.appBanner.findFirst({
      where: { placement: data.placement },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    sortOrder = (last?.sortOrder ?? 0) + 1;
  }
  const cleaned = ifEmptyDropCta(data);
  const b = await prisma.appBanner.create({ data: { ...cleaned, sortOrder } });
  await invalidate();
  return shape(b);
};

exports.update = async (id, data) => {
  const cleaned = ifEmptyDropCta(data);
  const b = await prisma.appBanner.update({ where: { id }, data: cleaned });
  await invalidate();
  return shape(b);
};

exports.remove = async (id) => {
  await prisma.appBanner.delete({ where: { id } });
  await invalidate();
  return { id };
};

exports.toggleActive = async (id) => {
  const current = await prisma.appBanner.findUnique({ where: { id }, select: { active: true } });
  if (!current) throw ApiError.notFound('Banner not found');
  const b = await prisma.appBanner.update({
    where: { id },
    data: { active: !current.active },
  });
  await invalidate();
  return shape(b);
};

exports.reorder = async (placement, orderedIds) => {
  const existing = await prisma.appBanner.findMany({
    where: { placement },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((b) => b.id));
  const seen = new Set();
  for (const id of orderedIds) {
    if (!existingIds.has(id)) throw ApiError.badRequest(`Unknown banner id for ${placement}: ${id}`);
    if (seen.has(id)) throw ApiError.badRequest(`Duplicate id in order: ${id}`);
    seen.add(id);
  }
  if (orderedIds.length !== existing.length) {
    throw ApiError.badRequest('Order list must contain every banner id for this placement exactly once');
  }
  await prisma.$transaction(
    orderedIds.map((id, i) =>
      prisma.appBanner.update({ where: { id }, data: { sortOrder: i + 1 } }),
    ),
  );
  /// Invalidate BEFORE re-listing so the next list() call returns the
  /// fresh post-reorder snapshot, not the stale pre-reorder one.
  await invalidate();
  return exports.list({ placement });
};
