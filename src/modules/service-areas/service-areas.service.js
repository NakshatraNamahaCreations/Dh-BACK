const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

const shape = (a) => ({
  id: a.id,
  city: a.city,
  state: a.state,
  pincodes: a.pincodes,
  categoryIds: a.categoryIds,
  active: a.active,
  surgeRuleCount: a._count?.surgeRules,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

const normalizePincodes = (raw) => {
  if (!Array.isArray(raw)) return [];
  // Dedupe + trim + keep only digit-strings (Indian pincodes are 6 digits but
  // we don't enforce length here so foreign markets aren't blocked).
  const seen = new Set();
  return raw
    .map((p) => String(p).trim())
    .filter((p) => p && /^\d{3,8}$/.test(p) && !seen.has(p) && seen.add(p));
};

exports.list = async () => {
  const items = await prisma.serviceArea.findMany({
    orderBy: { city: 'asc' },
    include: { _count: { select: { surgeRules: true } } },
  });
  return items.map(shape);
};

exports.get = async (id) => {
  const item = await prisma.serviceArea.findUnique({
    where: { id },
    include: { _count: { select: { surgeRules: true } } },
  });
  if (!item) throw ApiError.notFound('Service area not found');
  return shape(item);
};

exports.create = async (data) => {
  const existing = await prisma.serviceArea.findUnique({
    where: { city: data.city },
    select: { id: true },
  });
  if (existing) {
    throw ApiError.conflict(`A service area for "${data.city}" already exists`);
  }
  const item = await prisma.serviceArea.create({
    data: {
      city: data.city,
      state: data.state ?? null,
      pincodes: normalizePincodes(data.pincodes),
      categoryIds: data.categoryIds ?? [],
      active: data.active ?? true,
    },
    include: { _count: { select: { surgeRules: true } } },
  });
  return shape(item);
};

exports.update = async (id, data) => {
  const patch = {};
  if (data.city !== undefined) patch.city = data.city;
  if (data.state !== undefined) patch.state = data.state;
  if (data.pincodes !== undefined) patch.pincodes = normalizePincodes(data.pincodes);
  if (data.categoryIds !== undefined) patch.categoryIds = data.categoryIds;
  if (data.active !== undefined) patch.active = data.active;
  try {
    const item = await prisma.serviceArea.update({
      where: { id },
      data: patch,
      include: { _count: { select: { surgeRules: true } } },
    });
    return shape(item);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Service area not found');
    if (err.code === 'P2002') throw ApiError.conflict(`Another area already uses that city name`);
    throw err;
  }
};

exports.toggle = async (id) => {
  const current = await prisma.serviceArea.findUnique({
    where: { id },
    select: { active: true },
  });
  if (!current) throw ApiError.notFound('Service area not found');
  return exports.update(id, { active: !current.active });
};

exports.remove = async (id) => {
  try {
    await prisma.serviceArea.delete({ where: { id } });
    return { id };
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Service area not found');
    throw err;
  }
};

// ── Public cities list ───────────────────────────────────────────────────
//
// Used by the partner app onboarding screen so partners can pick their city.
exports.cities = async () => {
  const areas = await prisma.serviceArea.findMany({
    where: { active: true },
    orderBy: { city: 'asc' },
    select: { city: true, state: true },
  });
  return areas;
};

// ── Public coverage check ────────────────────────────────────────────────
//
// Used by the customer app at launch to decide whether to show the home
// experience or a "Coming soon" screen. Match logic, in priority order:
//
//   1. Pincode-first: if the supplied pincode appears in ANY active area's
//      `pincodes` whitelist, the customer is serviceable — regardless of
//      what their geocoder calls the city. Handles the "440016 is admin-
//      entered under Hingna but the phone says Nagpur" case where the
//      city-name path would fail.
//   2. City match: cityResolver.resolve() → cityId lookup → free-text
//      fallback. Picks the first active area for that city.
//   3. If found and area.pincodes is empty → serviceable (whole city).
//   4. If found and pincode supplied is in area.pincodes → serviceable.
//   5. Else → not serviceable, but we still hint the city *is* a launch
//      market so the UI can say "we're in Bengaluru but not your pincode yet".
exports.check = async ({ city, pincode }) => {
  const cityKey = String(city ?? '').trim();
  const pin = String(pincode ?? '').trim();

  /// Step 1 — pincode-first. If admin has explicitly whitelisted this
  /// pincode under any active service area, the customer is serviceable
  /// regardless of what their phone's geocoder calls the surrounding
  /// city. This is the path that fixes "I added 440016 under Hingna but
  /// the customer's geocoder returns Nagpur — they're being told no
  /// service" — pincodes are unambiguous, city names aren't.
  if (pin) {
    const pinMatch = await prisma.serviceArea.findFirst({
      where: { pincodes: { has: pin }, active: true },
      select: { id: true, city: true, pincodes: true, categoryIds: true },
    });
    if (pinMatch) {
      return {
        serviceable: true,
        city: pinMatch.city,
        pincode: pin,
        categoryIds: pinMatch.categoryIds,
      };
    }
  }

  if (!cityKey) {
    return { serviceable: false, reason: 'no_city', message: 'Enable location to check availability.' };
  }

  /// Step 2 — city match. Prefer cityId-based lookup when the resolver
  /// matches the free-text input to a real City row — exact, indexed,
  /// and not fooled by spelling drift. Fall back to the legacy
  /// case-insensitive lookup on `service_areas.city` when the resolver
  /// returns null (city not yet in the geography table).
  const cityResolver = require('../geography/city-resolver');
  const cityId = await cityResolver.resolve(cityKey);

  const area = cityId
    ? await prisma.serviceArea.findFirst({
        where: { cityId, active: true },
        select: { id: true, city: true, pincodes: true, categoryIds: true },
      }) ??
      /// Legacy ServiceArea rows whose cityId hasn't been backfilled
      /// yet — try the free-text path so we don't tell the customer
      /// "not serviced" while admin still hasn't run the backfill.
      (await prisma.serviceArea.findFirst({
        where: { city: { equals: cityKey, mode: 'insensitive' }, active: true },
        select: { id: true, city: true, pincodes: true, categoryIds: true },
      }))
    : await prisma.serviceArea.findFirst({
        where: { city: { equals: cityKey, mode: 'insensitive' }, active: true },
        select: { id: true, city: true, pincodes: true, categoryIds: true },
      });

  if (!area) {
    return {
      serviceable: false,
      reason: 'city_not_serviced',
      message: `Dhoond isn't live in ${cityKey} yet. We'll let you know when we are.`,
    };
  }

  // Whole-city mode → always serviceable here.
  if (area.pincodes.length === 0) {
    return {
      serviceable: true,
      city: area.city,
      pincode: pin || null,
      categoryIds: area.categoryIds,
    };
  }

  if (pin && area.pincodes.includes(pin)) {
    return { serviceable: true, city: area.city, pincode: pin, categoryIds: area.categoryIds };
  }

  return {
    serviceable: false,
    reason: 'pincode_not_serviced',
    city: area.city,
    message: `We're live in ${area.city} but not at ${pin || 'your pincode'} yet.`,
  };
};
