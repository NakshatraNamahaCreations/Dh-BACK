const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

/// Public shape returned over the wire — strips internal fields like
/// `usedCount` from customer responses but keeps them for admin views
/// (admin uses `adminShape` below).
const customerShape = (c) => ({
  id: c.id,
  code: c.code,
  description: c.description,
  discountType: c.discountType,
  discountValue: c.discountValue,
  minOrderValue: c.minOrderValue,
  maxDiscount: c.maxDiscount,
});

const adminShape = (c) => ({
  id: c.id,
  code: c.code,
  description: c.description,
  discountType: c.discountType,
  discountValue: c.discountValue,
  minOrderValue: c.minOrderValue,
  maxDiscount: c.maxDiscount,
  validFrom: c.validFrom,
  validUntil: c.validUntil,
  usageLimit: c.usageLimit,
  usedCount: c.usedCount,
  active: c.active,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

/// Compute the rupee discount for a given subtotal. Centralised here so
/// admin previews and customer apply both produce the same number.
const computeDiscount = (coupon, subtotal) => {
  if (coupon.discountType === 'PERCENT') {
    const raw = Math.floor((subtotal * coupon.discountValue) / 100);
    return coupon.maxDiscount != null ? Math.min(raw, coupon.maxDiscount) : raw;
  }
  /// FLAT: cap at subtotal so the booking total never goes negative.
  return Math.min(coupon.discountValue, subtotal);
};

/// Throw if the coupon row is unusable for the given subtotal/time. The
/// same checks fire on customer apply *and* booking creation — never
/// trust the apply call alone (the user could change the cart between
/// apply and book).
const assertUsable = (coupon, subtotal, now = new Date()) => {
  if (!coupon) throw ApiError.notFound('Coupon not found');
  if (!coupon.active) throw ApiError.badRequest('This coupon is inactive');
  if (coupon.validFrom && now < coupon.validFrom) {
    throw ApiError.badRequest('This coupon is not yet active');
  }
  if (coupon.validUntil && now > coupon.validUntil) {
    throw ApiError.badRequest('This coupon has expired');
  }
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    throw ApiError.badRequest('This coupon has reached its usage limit');
  }
  if (subtotal < (coupon.minOrderValue ?? 0)) {
    throw ApiError.badRequest(
      `Minimum order ₹${coupon.minOrderValue} required for this coupon`,
    );
  }
  /// FLAT coupons must never cover (or exceed) the whole order — a flat
  /// ₹566 coupon on a ₹229 cart would zero the bill (the clamp in
  /// computeDiscount silently ate the difference). The order total must
  /// be STRICTLY greater than the flat value for the coupon to apply,
  /// regardless of what minOrderValue the admin set.
  if (coupon.discountType !== 'PERCENT' && subtotal <= coupon.discountValue) {
    throw ApiError.badRequest(
      `Order total must be above ₹${coupon.discountValue} to use this coupon`,
    );
  }
};

/// ── Customer endpoints ────────────────────────────────────────────────

/// Validate a coupon code against an in-flight cart and return the
/// computed discount. Doesn't mutate `usedCount` — that happens at
/// booking creation. Subtotal is recomputed from real services to
/// stop a tampered client from inflating it past the minOrder gate.
exports.applyForCart = async ({ code, items }) => {
  if (!code || !items?.length) throw ApiError.badRequest('Coupon code and items required');

  const coupon = await prisma.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
  });

  /// Recompute subtotal from canonical service rows (same approach as
  /// bookings.create). This guarantees apply + book agree on the
  /// number even if the customer's cart is stale.
  const services = await prisma.service.findMany({
    where: { id: { in: items.map((i) => i.serviceId) } },
    select: { id: true, basePrice: true, active: true },
  });
  const map = new Map(services.map((s) => [s.id, s]));
  const subtotal = items.reduce((sum, i) => {
    const svc = map.get(i.serviceId);
    if (!svc || !svc.active) return sum;
    return sum + svc.basePrice * i.qty;
  }, 0);

  assertUsable(coupon, subtotal);

  const discount = computeDiscount(coupon, subtotal);

  return {
    coupon: customerShape(coupon),
    subtotal,
    discount,
    payable: Math.max(0, subtotal - discount),
  };
};

/// Customer-facing list of currently-claimable coupons — active, inside
/// their validity window, and not exhausted. Returns the same safe shape
/// as `apply` (no usedCount), plus `validUntil` so the app can show expiry.
/// The real discount is still re-validated on apply / at booking creation.
exports.listAvailable = async () => {
  const now = new Date();
  const coupons = await prisma.coupon.findMany({
    where: {
      active: true,
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
        { OR: [{ validUntil: null }, { validUntil: { gte: now } }] },
      ],
    },
    orderBy: [{ minOrderValue: 'asc' }, { discountValue: 'desc' }],
  });
  return coupons
    .filter((c) => c.usageLimit == null || c.usedCount < c.usageLimit)
    .map((c) => ({ ...customerShape(c), validUntil: c.validUntil }));
};

/// Internal — called by bookings.service.create after the cart's
/// subtotal is locked. Returns the computed discount and ensures
/// `usedCount` ticks atomically. Throws if the coupon is unusable
/// (so the booking transaction can roll back).
exports.redeemForBooking = async ({ code, subtotal, tx }) => {
  if (!code) return null;
  const client = tx ?? prisma;

  const coupon = await client.coupon.findUnique({
    where: { code: code.trim().toUpperCase() },
  });
  assertUsable(coupon, subtotal);
  const discount = computeDiscount(coupon, subtotal);

  /// Atomic increment guards against two concurrent bookings consuming
  /// the same last-remaining redemption. The where-clause re-checks
  /// usageLimit so the update is a no-op if another transaction got
  /// there first.
  const updated = await client.coupon.updateMany({
    where: {
      id: coupon.id,
      ...(coupon.usageLimit != null
        ? { usedCount: { lt: coupon.usageLimit } }
        : {}),
    },
    data: { usedCount: { increment: 1 } },
  });
  if (updated.count === 0) {
    throw ApiError.badRequest('This coupon has reached its usage limit');
  }

  return {
    couponId: coupon.id,
    couponCode: coupon.code,
    discount,
  };
};

/// Reverse a redemption when its booking is cancelled before it could
/// be fulfilled — typically when no partner accepted within the
/// broadcast window, or when the customer/admin cancels a still-PENDING
/// booking. Decrements `usedCount` (clamped at zero, so a double-call
/// from a race / retry can't drive it negative). No-op when there's no
/// coupon attached. Idempotency is the caller's responsibility — only
/// invoke this from the same transaction that flips the booking to
/// CANCELLED, gated on the booking not already being CANCELLED.
exports.refundForBooking = async ({ couponId, tx }) => {
  if (couponId == null) return;
  const client = tx ?? prisma;
  await client.coupon.updateMany({
    where: { id: Number(couponId), usedCount: { gt: 0 } },
    data: { usedCount: { decrement: 1 } },
  });
};

/// ── Admin endpoints ───────────────────────────────────────────────────

exports.adminList = async ({ search, status, page = 1, pageSize = 25 } = {}) => {
  const where = {};
  if (search) {
    where.OR = [
      { code: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (status === 'active') where.active = true;
  if (status === 'inactive') where.active = false;

  const [items, total] = await Promise.all([
    prisma.coupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.coupon.count({ where }),
  ]);

  return {
    data: items.map(adminShape),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

exports.adminGet = async (id) => {
  const c = await prisma.coupon.findUnique({ where: { id: Number(id) } });
  if (!c) throw ApiError.notFound('Coupon not found');
  return adminShape(c);
};

const normaliseInput = (data) => ({
  code: data.code?.trim().toUpperCase(),
  description: data.description?.trim() || null,
  discountType: data.discountType,
  discountValue: data.discountValue,
  minOrderValue: data.minOrderValue ?? 0,
  maxDiscount: data.maxDiscount ?? null,
  validFrom: data.validFrom ? new Date(data.validFrom) : null,
  validUntil: data.validUntil ? new Date(data.validUntil) : null,
  usageLimit: data.usageLimit ?? null,
  active: data.active ?? true,
});

exports.adminCreate = async (data) => {
  const input = normaliseInput(data);
  /// Guard: percentage codes can't exceed 100 (would create negative
  /// totals). Validator already does this but the service is the
  /// last line of defence.
  if (input.discountType === 'PERCENT' && input.discountValue > 100) {
    throw ApiError.badRequest('Percentage discount cannot exceed 100');
  }
  const existing = await prisma.coupon.findUnique({ where: { code: input.code } });
  if (existing) throw ApiError.conflict('A coupon with this code already exists');

  const created = await prisma.coupon.create({ data: input });
  return adminShape(created);
};

exports.adminUpdate = async (id, data) => {
  const input = normaliseInput(data);
  if (input.discountType === 'PERCENT' && input.discountValue > 100) {
    throw ApiError.badRequest('Percentage discount cannot exceed 100');
  }
  /// If the code is changing, make sure the new code isn't taken by a
  /// different coupon row.
  const existing = await prisma.coupon.findUnique({ where: { code: input.code } });
  if (existing && existing.id !== Number(id)) {
    throw ApiError.conflict('A coupon with this code already exists');
  }
  try {
    const updated = await prisma.coupon.update({
      where: { id: Number(id) },
      data: input,
    });
    return adminShape(updated);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Coupon not found');
    throw err;
  }
};

exports.adminDelete = async (id) => {
  try {
    await prisma.coupon.delete({ where: { id: Number(id) } });
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Coupon not found');
    throw err;
  }
};

exports.adminToggleActive = async (id) => {
  const c = await prisma.coupon.findUnique({ where: { id: Number(id) } });
  if (!c) throw ApiError.notFound('Coupon not found');
  const updated = await prisma.coupon.update({
    where: { id: c.id },
    data: { active: !c.active },
  });
  return adminShape(updated);
};
