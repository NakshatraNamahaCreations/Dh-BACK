const redis = require('../config/redis');
const env = require('../config/env');
const logger = require('../config/logger');

/// Tiny Redis cache facade. All methods are safe to call when Redis is
/// disabled or unreachable — they short-circuit to "cache miss" and
/// the caller falls through to whatever loader function it passed in.
///
/// Why no-op-on-error instead of throw: a flaky cache should never
/// degrade the API into 500s. Worst case we serve cold DB reads; best
/// case we save a query. The asymmetry is intentional.

const enabled = () => redis !== null && redis.status === 'ready';

const safe = async (op, fallback) => {
  if (!enabled()) return fallback;
  try {
    return await op();
  } catch (err) {
    logger.warn(`Cache op failed: ${err.message}`);
    return fallback;
  }
};

const get = async (key) => {
  return safe(async () => {
    const raw = await redis.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      /// Stale / corrupted entry — drop it so the next caller refills
      /// with a clean value instead of hitting the same parse error.
      await redis.del(key).catch(() => {});
      return null;
    }
  }, null);
};

const set = async (key, value, ttlSeconds = env.REDIS_TTL_SECONDS) => {
  return safe(async () => {
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  }, undefined);
};

const del = async (...keys) => {
  if (keys.length === 0) return;
  return safe(async () => {
    await redis.del(...keys);
  }, undefined);
};

/// Wipe every key matching `prefix*`. Uses SCAN (not KEYS) so it stays
/// non-blocking even on large keyspaces — KEYS would freeze the whole
/// Redis instance under heavy load.
const delByPrefix = async (prefix) => {
  return safe(async () => {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 200 });
    const pipeline = redis.pipeline();
    let pending = 0;
    await new Promise((resolve, reject) => {
      stream.on('data', (keys) => {
        for (const k of keys) {
          pipeline.del(k);
          pending += 1;
        }
      });
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    if (pending > 0) await pipeline.exec();
  }, undefined);
};

/// Read-through cache: returns cached value when present, otherwise
/// runs `loader`, caches the result, and returns it. Errors thrown by
/// `loader` propagate to the caller and are NOT cached.
const getOrSet = async (key, ttlSeconds, loader) => {
  const hit = await get(key);
  if (hit !== null) return hit;
  const fresh = await loader();
  /// Don't cache `undefined` (`JSON.stringify(undefined) === undefined`,
  /// which Redis would reject) but DO cache `null` — a deliberate
  /// "this id is genuinely missing" answer is just as useful to cache
  /// as a populated row. (Note: `get` returns null on a real miss too,
  /// but a follow-up loader call costs little, so we accept that.)
  if (fresh !== undefined) await set(key, fresh, ttlSeconds);
  return fresh;
};

module.exports = {
  enabled,
  get,
  set,
  del,
  delByPrefix,
  getOrSet,
};
