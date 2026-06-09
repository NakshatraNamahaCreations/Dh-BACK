const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const cityResolver = require('../geography/city-resolver');

const baseShape = (c) => ({
  id: c.id,
  phone: c.phone,
  name: c.name,
  email: c.email,
  isActive: c.isActive,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

// ── Directory list ─────────────────────────────────────────────────────────
//
// Returns a paginated list of customers enriched with a booking-stats block:
// totalBookings, totalSpent, lastBookingAt. Supports search across
// phone/name/email, active-only filter, and a `sort` knob so the table can
// surface biggest spenders or most recent.
exports.list = async ({
  search,
  status,
  scope,
  sort = 'recent',
  page = 1,
  pageSize = 25,
} = {}) => {
  const { applyScopeToRelation } = require('../../middlewares/adminScope');
  const where = {};
  if (status === 'active') where.isActive = true;
  else if (status === 'paused') where.isActive = false;
  if (search) {
    where.OR = [
      { phone: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
    ];
  }
  /// Customers don't carry their own cityId — scope via the
  /// `bookings.some.cityId` relation. SUPER admin with no filter is
  /// a no-op; CITY_MANAGER intersection happens inside the helper.
  if (scope) applyScopeToRelation(where, scope, 'bookings');

  // For "recent" sort we can paginate at the DB level. Other sorts need
  // booking aggregates first, so we pull all matching customers and sort in
  // memory (fine until ~50k customers; revisit when we get there).
  if (sort === 'recent') {
    const [rows, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.customer.count({ where }),
    ]);
    const data = await enrichWithStats(rows);
    return {
      data,
      meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    };
  }

  const all = await prisma.customer.findMany({ where });
  const enriched = await enrichWithStats(all);
  enriched.sort((a, b) => {
    if (sort === 'spend') return b.totalSpent - a.totalSpent;
    if (sort === 'bookings') return b.totalBookings - a.totalBookings;
    return 0;
  });
  const total = enriched.length;
  const slice = enriched.slice((page - 1) * pageSize, page * pageSize);
  return {
    data: slice,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

// Adds booking-derived stats to a list of customers in one round-trip.
const enrichWithStats = async (rows) => {
  if (rows.length === 0) return [];
  const ids = rows.map((c) => c.id);

  const [agg, lastBookings, recentLocations] = await Promise.all([
    prisma.booking.groupBy({
      by: ['customerId'],
      where: { customerId: { in: ids } },
      _count: { _all: true },
      _sum: { total: true },
    }),
    // Last booking timestamp per customer.
    prisma.booking.groupBy({
      by: ['customerId'],
      where: { customerId: { in: ids } },
      _max: { createdAt: true },
    }),
    /// Customers don't carry their own city — we surface the city of
    /// their most-recent booking so the admin's State→City filter
    /// has something useful to show in the table. `distinct` on
    /// customerId with `orderBy: createdAt desc` returns one row per
    /// customer (the latest), avoiding an N+1 fan-out.
    prisma.booking.findMany({
      where: { customerId: { in: ids } },
      orderBy: { createdAt: 'desc' },
      distinct: ['customerId'],
      select: {
        customerId: true,
        city: true,
        cityRef: { select: { name: true, state: { select: { name: true, code: true } } } },
        /// FK-first city read; falls back to snapshot for legacy rows.
        customerAddress: { select: { city: true } },
      },
    }),
  ]);

  const countById = new Map(agg.map((a) => [a.customerId, a]));
  const lastById = new Map(lastBookings.map((l) => [l.customerId, l._max.createdAt]));
  const locById = new Map(
    recentLocations.map((b) => [
      b.customerId,
      {
        city: b.cityRef?.name ?? b.customerAddress?.city ?? b.city ?? null,
        state: b.cityRef?.state?.name ?? null,
        stateCode: b.cityRef?.state?.code ?? null,
      },
    ]),
  );

  return rows.map((c) => {
    const a = countById.get(c.id);
    const loc = locById.get(c.id) ?? { city: null, state: null, stateCode: null };
    return {
      ...baseShape(c),
      totalBookings: a?._count?._all ?? 0,
      totalSpent: a?._sum?.total ?? 0,
      lastBookingAt: lastById.get(c.id) ?? null,
      city: loc.city,
      state: loc.state,
      stateCode: loc.stateCode,
    };
  });
};

// ── Detail ─────────────────────────────────────────────────────────────────

exports.get = async (id) => {
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) throw ApiError.notFound('Customer not found');

  const [agg, recentRows, addresses] = await Promise.all([
    prisma.booking.aggregate({
      where: { customerId: id },
      _count: { _all: true },
      _sum: { total: true },
      _max: { createdAt: true },
      _min: { createdAt: true },
    }),
    prisma.booking.findMany({
      where: { customerId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        items: { select: { serviceName: true, qty: true, basePrice: true } },
        /// FK-first address read so the customer-detail page can
        /// render booking addresses for new (snapshot-less) rows.
        customerAddress: {
          select: { addressLine: true, city: true, lat: true, lng: true, label: true },
        },
      },
    }),
    /// Customer's saved addresses — the canonical source. We used to
    /// derive these from distinct booking.addressLine values back when
    /// the booking row carried the snapshot; now we just read straight
    /// from `customer_addresses`.
    prisma.customerAddress.findMany({
      where: { customerId: id },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      select: { label: true, addressLine: true, city: true, lat: true, lng: true },
      take: 5,
    }),
  ]);

  const totalBookings = agg._count?._all ?? 0;
  const totalSpent = agg._sum?.total ?? 0;
  const completedCount = await prisma.booking.count({
    where: { customerId: id, status: 'COMPLETED' },
  });
  const cancelledCount = await prisma.booking.count({
    where: { customerId: id, status: 'CANCELLED' },
  });

  return {
    ...baseShape(customer),
    stats: {
      totalBookings,
      totalSpent,
      completedCount,
      cancelledCount,
      averageOrderValue: totalBookings > 0 ? Math.round(totalSpent / totalBookings) : 0,
      firstBookingAt: agg._min?.createdAt ?? null,
      lastBookingAt: agg._max?.createdAt ?? null,
    },
    /// Re-shape so the admin client keeps reading the same field
    /// names the old denormalised version emitted (`addressLabel`
    /// instead of `label`). Source has changed (was distinct booking
    /// rows, now customer_addresses) but the wire format hasn't.
    addresses: addresses.map((a) => ({
      addressLabel: a.label,
      addressLine: a.addressLine,
      city: a.city,
      lat: a.lat,
      lng: a.lng,
    })),
    recentBookings: recentRows.map((b) => ({
      id: b.id,
      status: b.status,
      scheduledAt: b.scheduledAt,
      slotLabel: b.slotLabel,
      /// FK-first read; legacy snapshot is the fallback.
      city: b.customerAddress?.city ?? b.city,
      addressLine: b.customerAddress?.addressLine ?? b.addressLine,
      total: b.total,
      offeredPrice: b.offeredPrice,
      itemCount: b.items.length,
      itemsPreview: b.items.slice(0, 3).map((i) => `${i.serviceName} ×${i.qty}`).join(', '),
      createdAt: b.createdAt,
    })),
  };
};

exports.toggleActive = async (id) => {
  const current = await prisma.customer.findUnique({ where: { id }, select: { isActive: true } });
  if (!current) throw ApiError.notFound('Customer not found');
  try {
    await prisma.customer.update({
      where: { id },
      data: { isActive: !current.isActive },
    });
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Customer not found');
    throw err;
  }
  return exports.get(id);
};

// ── Customer-facing saved addresses ────────────────────────────────────────

const addressShape = (a) => ({
  id: a.id,
  label: a.label,
  addressLine: a.addressLine,
  city: a.city,
  pincode: a.pincode,
  lat: a.lat,
  lng: a.lng,
  floor: a.floor ?? null,
  building: a.building ?? null,
  landmark: a.landmark ?? null,
  receiverName: a.receiverName ?? null,
  receiverPhone: a.receiverPhone ?? null,
  isDefault: a.isDefault,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

/// "Default first, then most recently used" — same order the customer-app
/// renders the list, computed at the DB layer so there's no shuffling on
/// the client.
const ADDRESS_ORDER = [{ isDefault: 'desc' }, { updatedAt: 'desc' }];

exports.listAddresses = async (customerId) => {
  const rows = await prisma.customerAddress.findMany({
    where: { customerId: Number(customerId) },
    orderBy: ADDRESS_ORDER,
  });
  return rows.map(addressShape);
};

exports.createAddress = async (customerId, payload) => {
  const cid = Number(customerId);

  /// When the new address is flagged default, demote the previous one in
  /// the same transaction. Otherwise, if this is the customer's first
  /// address ever, promote it to default automatically — no point
  /// having a list with no default.
  const existing = await prisma.customerAddress.count({ where: { customerId: cid } });
  const wantsDefault = payload.isDefault === true || existing === 0;

  /// Resolve the geography FK from the free-text city. Resolved
  /// outside the transaction to keep the txn short — the resolver
  /// is in-process cached so it's a hashmap lookup ~99% of the time.
  const cityId = await cityResolver.resolve(payload.city);

  const row = await prisma.$transaction(async (tx) => {
    if (wantsDefault) {
      await tx.customerAddress.updateMany({
        where: { customerId: cid, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.customerAddress.create({
      data: {
        customerId: cid,
        label: payload.label,
        addressLine: payload.addressLine,
        city: payload.city,
        cityId,
        pincode: payload.pincode ?? null,
        lat: payload.lat ?? null,
        lng: payload.lng ?? null,
        floor: payload.floor ?? null,
        building: payload.building ?? null,
        landmark: payload.landmark ?? null,
        receiverName: payload.receiverName ?? null,
        receiverPhone: payload.receiverPhone ?? null,
        isDefault: wantsDefault,
      },
    });
  });
  return addressShape(row);
};

exports.updateAddress = async (customerId, addressId, payload) => {
  const cid = Number(customerId);
  const aid = Number(addressId);
  const existing = await prisma.customerAddress.findUnique({ where: { id: aid } });
  if (!existing || existing.customerId !== cid) throw ApiError.notFound('Address not found');

  const wantsDefault = payload.isDefault === true && !existing.isDefault;

  /// Re-resolve cityId only when the city string itself changed —
  /// otherwise we risk overwriting an admin-corrected cityId every
  /// time the customer hits Save with the same city.
  let cityId;
  if (payload.city != null && payload.city !== existing.city) {
    cityId = await cityResolver.resolve(payload.city);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (wantsDefault) {
      await tx.customerAddress.updateMany({
        where: { customerId: cid, isDefault: true },
        data: { isDefault: false },
      });
    }
    return tx.customerAddress.update({
      where: { id: aid },
      data: {
        ...(payload.label != null && { label: payload.label }),
        ...(payload.addressLine != null && { addressLine: payload.addressLine }),
        ...(payload.city != null && { city: payload.city }),
        ...(cityId !== undefined && { cityId }),
        ...(payload.pincode !== undefined && { pincode: payload.pincode }),
        ...(payload.lat !== undefined && { lat: payload.lat }),
        ...(payload.lng !== undefined && { lng: payload.lng }),
        ...(payload.floor !== undefined && { floor: payload.floor }),
        ...(payload.building !== undefined && { building: payload.building }),
        ...(payload.landmark !== undefined && { landmark: payload.landmark }),
        ...(payload.receiverName !== undefined && { receiverName: payload.receiverName }),
        ...(payload.receiverPhone !== undefined && { receiverPhone: payload.receiverPhone }),
        /// `isDefault: false` is a no-op explicitly — we never let the
        /// customer remove the default flag without choosing another
        /// row, otherwise the customer would have zero defaults.
        ...(wantsDefault && { isDefault: true }),
      },
    });
  });
  return addressShape(updated);
};

exports.deleteAddress = async (customerId, addressId) => {
  const cid = Number(customerId);
  const aid = Number(addressId);
  const existing = await prisma.customerAddress.findUnique({ where: { id: aid } });
  if (!existing || existing.customerId !== cid) throw ApiError.notFound('Address not found');

  await prisma.$transaction(async (tx) => {
    await tx.customerAddress.delete({ where: { id: aid } });
    /// If we just deleted the default, promote the most recent
    /// remaining address so the customer never ends up with addresses
    /// but no default.
    if (existing.isDefault) {
      const next = await tx.customerAddress.findFirst({
        where: { customerId: cid },
        orderBy: { updatedAt: 'desc' },
      });
      if (next) {
        await tx.customerAddress.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
  });
  return { ok: true };
};

exports.setDefaultAddress = async (customerId, addressId) => {
  const cid = Number(customerId);
  const aid = Number(addressId);
  const existing = await prisma.customerAddress.findUnique({ where: { id: aid } });
  if (!existing || existing.customerId !== cid) throw ApiError.notFound('Address not found');

  await prisma.$transaction(async (tx) => {
    await tx.customerAddress.updateMany({
      where: { customerId: cid, isDefault: true },
      data: { isDefault: false },
    });
    await tx.customerAddress.update({
      where: { id: aid },
      data: { isDefault: true },
    });
  });
  return addressShape({ ...existing, isDefault: true });
};
