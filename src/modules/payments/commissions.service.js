const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

/**
 * Commission rules — one row per service category, holding the
 * percentage of each completed booking's total that goes to the
 * partner. The remainder is the platform's revenue.
 *
 * Categories without an explicit row use `DEFAULT_PARTNER_PCT` so a
 * fresh install behaves predictably (and an admin who forgets to
 * configure a new category doesn't have unpaid partners).
 *
 * Surface area:
 *   listAll()                      — all categories with their effective %
 *   getEffectivePctForCategory()   — used by earnings.creditForBooking()
 *                                    to snapshot the rate at credit time
 *   upsertMany()                   — admin save: replace the rules table
 *                                    in one transaction
 */

const DEFAULT_PARTNER_PCT = 80;

const shape = (category, rule) => ({
  categoryId: category.id,
  category: category.name,
  partnerPct: rule?.partnerPct ?? DEFAULT_PARTNER_PCT,
  /// `configured: false` lets the admin UI mark categories that fall
  /// back to the default vs ones the team has explicitly set, so a
  /// quick scan shows what's been reviewed.
  configured: !!rule,
  updatedAt: rule?.updatedAt ?? null,
});

exports.listAll = async () => {
  const [categories, rules] = await Promise.all([
    prisma.category.findMany({
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    }),
    prisma.commissionRule.findMany(),
  ]);
  const ruleByCat = new Map(rules.map((r) => [r.categoryId, r]));
  return categories.map((c) => shape(c, ruleByCat.get(c.id)));
};

/// Fast-path used by the earnings credit flow. Returns the partner's
/// percentage for this category (0–100). Falls back to the default
/// when no rule has been configured.
exports.getEffectivePctForCategory = async (categoryId) => {
  if (!categoryId) return DEFAULT_PARTNER_PCT;
  const rule = await prisma.commissionRule.findUnique({
    where: { categoryId: Number(categoryId) },
    select: { partnerPct: true },
  });
  return rule?.partnerPct ?? DEFAULT_PARTNER_PCT;
};

/// Bulk upsert from the admin form. Validated rows: `partnerPct`
/// must be 0–100 inclusive, `categoryId` must reference a real
/// category. Done inside a transaction so a partial failure can't
/// leave half the table updated.
exports.upsertMany = async (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw ApiError.badRequest('No rows to save');
  }

  for (const r of rows) {
    if (typeof r.partnerPct !== 'number' || r.partnerPct < 0 || r.partnerPct > 100) {
      throw ApiError.badRequest(`partnerPct must be 0-100 (got ${r.partnerPct} for category ${r.categoryId})`);
    }
  }

  const categoryIds = rows.map((r) => Number(r.categoryId));
  const known = await prisma.category.findMany({
    where: { id: { in: categoryIds } },
    select: { id: true },
  });
  const knownSet = new Set(known.map((c) => c.id));
  const missing = categoryIds.filter((id) => !knownSet.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(`Unknown category ids: ${missing.join(', ')}`);
  }

  await prisma.$transaction(
    rows.map((r) =>
      prisma.commissionRule.upsert({
        where: { categoryId: Number(r.categoryId) },
        create: {
          categoryId: Number(r.categoryId),
          partnerPct: Math.round(r.partnerPct),
        },
        update: {
          partnerPct: Math.round(r.partnerPct),
        },
      }),
    ),
  );
  return exports.listAll();
};

exports.DEFAULT_PARTNER_PCT = DEFAULT_PARTNER_PCT;
