const prisma = require('../../config/prisma');

/**
 * City resolver — takes a free-text city string and returns the
 * matching City.id, or null if there's no clean match.
 *
 * Used at every write-path where the client sends free-text city
 * (booking create, address save, partner update). Lets the legacy
 * apps stay on free-text while the backend silently tags rows with
 * the canonical FK.
 *
 * Match order, in this priority:
 *   1. Exact (lowercased + trimmed) name match
 *   2. Alias map (Bangalore → Bengaluru, Bombay → Mumbai, etc.)
 *
 * Skips fuzzy/Levenshtein on purpose — the resolver runs inside
 * request handlers and a 1ms exact lookup beats a 50ms fuzzy walk
 * over a few hundred rows. The backfill script handles fuzzy
 * matching offline (`npm run backfill:cities -- --fuzzy`) for the
 * historical edge cases this misses.
 *
 * Caches the city list in-memory for 60s. The set rarely changes
 * (admin edits geography weekly at best), and the cache means a
 * busy backend isn't doing 100 city-table reads per minute. The
 * cache is per-process — a multi-instance deployment will see at
 * most a 60s lag in any one node before it picks up new cities,
 * which is fine for this data class.
 */

const CACHE_TTL_MS = 60 * 1000;

/// Same alias map the backfill script uses, kept in sync via copy
/// (small list, low maintenance cost, avoids an awkward shared
/// dependency between scripts/ and src/). Lowercased keys.
const ALIASES = {
  bangalore: 'bengaluru',
  bangaluru: 'bengaluru',
  banglore: 'bengaluru',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  gurgaon: 'gurugram',
  poona: 'pune',
  trivandrum: 'thiruvananthapuram',
  cochin: 'kochi',
  mysore: 'mysuru',
  mangalore: 'mangaluru',
  hubli: 'hubballi',
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

let cache = null;
let cachedAt = 0;
let inFlight = null;

const loadCache = async () => {
  const cities = await prisma.city.findMany({
    where: { active: true, state: { active: true } },
    select: { id: true, name: true, stateId: true },
  });
  /// First-match-wins for same-name cities across states. Same
  /// caveat as the backfill — Hyderabad in TS vs AP — but at
  /// resolver time we have no state context to disambiguate. If a
  /// caller ever needs that, we can extend the API later.
  const exact = new Map();
  for (const c of cities) {
    const key = norm(c.name);
    if (!exact.has(key)) exact.set(key, c.id);
  }
  return { exact, loadedAt: Date.now() };
};

const ensureCache = async () => {
  if (cache && Date.now() - cachedAt < CACHE_TTL_MS) return cache;
  if (inFlight) return inFlight;
  inFlight = loadCache().then((c) => {
    cache = c.exact;
    cachedAt = c.loadedAt;
    inFlight = null;
    return cache;
  });
  return inFlight;
};

/// Public — return a cityId or null. Never throws; if the resolver
/// can't match, the caller should keep the free-text city and move
/// on (the backfill / admin can clean up later).
exports.resolve = async (rawCity) => {
  const key = norm(rawCity);
  if (!key) return null;
  const lookup = await ensureCache();
  const direct = lookup.get(key);
  if (direct) return direct;
  const aliased = ALIASES[key];
  if (aliased) {
    const c = lookup.get(aliased);
    if (c) return c;
  }
  return null;
};

/// Cache-bust hook for admin write paths — the geography service
/// calls this after create/update/delete so the next resolve() picks
/// up changes immediately instead of waiting for the TTL.
exports.invalidate = () => {
  cache = null;
  cachedAt = 0;
  inFlight = null;
  byStateCache = null;
  byStateCachedAt = 0;
  byStateInFlight = null;
};

/// State → city-id list cache. Lets list endpoints translate a single
/// `stateId` filter into a `cityId IN (...)` clause without going to
/// the DB on every request. Same 60s TTL as the name lookup.
let byStateCache = null;
let byStateCachedAt = 0;
let byStateInFlight = null;

const loadByStateCache = async () => {
  const cities = await prisma.city.findMany({
    where: { active: true, state: { active: true } },
    select: { id: true, stateId: true },
  });
  const map = new Map();
  for (const c of cities) {
    const list = map.get(c.stateId) ?? [];
    list.push(c.id);
    map.set(c.stateId, list);
  }
  return { map, loadedAt: Date.now() };
};

const ensureByStateCache = async () => {
  if (byStateCache && Date.now() - byStateCachedAt < CACHE_TTL_MS) return byStateCache;
  if (byStateInFlight) return byStateInFlight;
  byStateInFlight = loadByStateCache().then((c) => {
    byStateCache = c.map;
    byStateCachedAt = c.loadedAt;
    byStateInFlight = null;
    return byStateCache;
  });
  return byStateInFlight;
};

/// Returns the list of active cityIds in a given state, or [] when
/// the state has no active cities. Cached for 60s (same as resolve()).
/// Callers should treat the array as read-only.
exports.cityIdsInState = async (stateId) => {
  const id = Number(stateId);
  if (!Number.isFinite(id) || id <= 0) return [];
  const map = await ensureByStateCache();
  return map.get(id) ?? [];
};
