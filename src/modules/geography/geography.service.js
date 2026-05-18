const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const cityResolver = require('./city-resolver');

/**
 * Geography service — admin CRUD for States and Cities, plus the
 * read endpoints customer/partner clients use for dropdowns.
 *
 * Two flavours of read:
 *   listAllStates / listAllCities — admin views, includes counts
 *   listActiveCities              — public dropdown, no counts, gated
 *                                    on state.active AND city.active
 */

// ── States ────────────────────────────────────────────────────────────────

const stateShape = (s, counts) => ({
  id: s.id,
  name: s.name,
  code: s.code,
  active: s.active,
  cityCount: counts?.cities ?? 0,
  activeCityCount: counts?.activeCities ?? 0,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

exports.listAllStates = async () => {
  const states = await prisma.state.findMany({
    orderBy: { name: 'asc' },
  });
  if (states.length === 0) return [];

  /// One groupBy each for "all cities" and "active cities" so the
  /// list view can show "12 cities (8 active)" per state.
  const stateIds = states.map((s) => s.id);
  const [cityCounts, activeCounts] = await Promise.all([
    prisma.city.groupBy({
      by: ['stateId'],
      where: { stateId: { in: stateIds } },
      _count: { _all: true },
    }),
    prisma.city.groupBy({
      by: ['stateId'],
      where: { stateId: { in: stateIds }, active: true },
      _count: { _all: true },
    }),
  ]);

  const total = new Map(cityCounts.map((r) => [r.stateId, r._count._all]));
  const live = new Map(activeCounts.map((r) => [r.stateId, r._count._all]));
  return states.map((s) =>
    stateShape(s, {
      cities: total.get(s.id) ?? 0,
      activeCities: live.get(s.id) ?? 0,
    }),
  );
};

exports.createState = async ({ name, code }) => {
  const existing = await prisma.state.findUnique({ where: { name } });
  if (existing) throw ApiError.conflict(`State "${name}" already exists`);
  const s = await prisma.state.create({
    data: { name: name.trim(), code: code?.trim() || null },
  });
  cityResolver.invalidate();
  return stateShape(s);
};

exports.updateState = async (id, { name, code, active }) => {
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (code !== undefined) data.code = code?.trim() || null;
  if (active !== undefined) data.active = active;
  try {
    const s = await prisma.state.update({ where: { id: Number(id) }, data });
    cityResolver.invalidate();
    return stateShape(s);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('State not found');
    if (err.code === 'P2002') throw ApiError.conflict('A state with that name already exists');
    throw err;
  }
};

exports.deleteState = async (id) => {
  /// Block delete if any cities reference this state. Caller should
  /// reassign or delete the cities first; we don't auto-cascade
  /// because that would orphan partners/bookings tied to those cities.
  const linked = await prisma.city.count({ where: { stateId: Number(id) } });
  if (linked > 0) {
    throw ApiError.conflict(
      `Cannot delete — ${linked} ${linked === 1 ? 'city is' : 'cities are'} still linked to this state.`,
    );
  }
  try {
    await prisma.state.delete({ where: { id: Number(id) } });
    cityResolver.invalidate();
    return { id: Number(id) };
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('State not found');
    throw err;
  }
};

// ── Cities ────────────────────────────────────────────────────────────────

const cityShape = (c, counts) => ({
  id: c.id,
  name: c.name,
  stateId: c.stateId,
  state: c.state ? c.state.name : undefined,
  stateCode: c.state ? c.state.code : undefined,
  active: c.active,
  lat: c.lat,
  lng: c.lng,
  launchedAt: c.launchedAt,
  partnerCount: counts?.partners ?? 0,
  bookingCount: counts?.bookings ?? 0,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

exports.listAllCities = async ({ stateId, search, active } = {}) => {
  const where = {};
  if (stateId) where.stateId = Number(stateId);
  if (typeof active === 'boolean') where.active = active;
  if (search) {
    where.name = { contains: String(search).trim(), mode: 'insensitive' };
  }

  const cities = await prisma.city.findMany({
    where,
    include: { state: true },
    orderBy: [{ state: { name: 'asc' } }, { name: 'asc' }],
  });
  if (cities.length === 0) return [];

  const cityIds = cities.map((c) => c.id);
  const [partnerCounts, bookingCounts] = await Promise.all([
    prisma.partner.groupBy({
      by: ['cityId'],
      where: { cityId: { in: cityIds } },
      _count: { _all: true },
    }),
    prisma.booking.groupBy({
      by: ['cityId'],
      where: { cityId: { in: cityIds } },
      _count: { _all: true },
    }),
  ]);

  const partnersByCity = new Map(partnerCounts.map((r) => [r.cityId, r._count._all]));
  const bookingsByCity = new Map(bookingCounts.map((r) => [r.cityId, r._count._all]));

  return cities.map((c) =>
    cityShape(c, {
      partners: partnersByCity.get(c.id) ?? 0,
      bookings: bookingsByCity.get(c.id) ?? 0,
    }),
  );
};

/// Public dropdown — what customer-app + partner-app fetch when a
/// user is choosing a city. No counts (cheap) and only active rows
/// inside active states (so toggling a state hides every city in
/// it without needing per-row updates).
exports.listActiveCities = async () => {
  const cities = await prisma.city.findMany({
    where: { active: true, state: { active: true } },
    include: { state: { select: { id: true, name: true, code: true } } },
    orderBy: [{ state: { name: 'asc' } }, { name: 'asc' }],
  });
  return cities.map((c) => ({
    id: c.id,
    name: c.name,
    stateId: c.stateId,
    state: c.state.name,
    stateCode: c.state.code,
    lat: c.lat,
    lng: c.lng,
  }));
};

exports.createCity = async ({ name, stateId, lat, lng, launchedAt }) => {
  const state = await prisma.state.findUnique({ where: { id: Number(stateId) } });
  if (!state) throw ApiError.badRequest('Unknown state');
  const dup = await prisma.city.findUnique({
    where: { name_stateId: { name: name.trim(), stateId: Number(stateId) } },
  });
  if (dup) throw ApiError.conflict(`"${name}" already exists in ${state.name}`);

  const c = await prisma.city.create({
    data: {
      name: name.trim(),
      stateId: Number(stateId),
      lat: lat == null ? null : Number(lat),
      lng: lng == null ? null : Number(lng),
      launchedAt: launchedAt ? new Date(launchedAt) : null,
    },
    include: { state: true },
  });
  cityResolver.invalidate();
  return cityShape(c);
};

exports.updateCity = async (id, { name, stateId, lat, lng, active, launchedAt }) => {
  const data = {};
  if (name !== undefined) data.name = name.trim();
  if (stateId !== undefined) data.stateId = Number(stateId);
  if (lat !== undefined) data.lat = lat == null ? null : Number(lat);
  if (lng !== undefined) data.lng = lng == null ? null : Number(lng);
  if (active !== undefined) data.active = active;
  if (launchedAt !== undefined) {
    data.launchedAt = launchedAt ? new Date(launchedAt) : null;
  }

  try {
    const c = await prisma.city.update({
      where: { id: Number(id) },
      data,
      include: { state: true },
    });
    cityResolver.invalidate();
    return cityShape(c);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('City not found');
    if (err.code === 'P2002') {
      throw ApiError.conflict('A city with that name already exists in this state');
    }
    throw err;
  }
};

exports.deleteCity = async (id) => {
  /// Cities are referenced by Booking/Partner/CustomerAddress/
  /// ServiceArea via SET-NULL FKs. Deleting is technically safe but
  /// loses the cityId backfill; we soft-block by surfacing usage so
  /// admins prefer toggling `active` instead.
  const cityId = Number(id);
  const [partners, bookings, addresses, areas] = await Promise.all([
    prisma.partner.count({ where: { cityId } }),
    prisma.booking.count({ where: { cityId } }),
    prisma.customerAddress.count({ where: { cityId } }),
    prisma.serviceArea.count({ where: { cityId } }),
  ]);
  const total = partners + bookings + addresses + areas;
  if (total > 0) {
    throw ApiError.conflict(
      `City is in use (${partners} partners, ${bookings} bookings, ${addresses} addresses, ${areas} service areas). Toggle "active" instead, or reassign first.`,
    );
  }
  try {
    await prisma.city.delete({ where: { id: cityId } });
    cityResolver.invalidate();
    return { id: cityId };
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('City not found');
    throw err;
  }
};
