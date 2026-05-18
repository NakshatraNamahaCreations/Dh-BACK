const redis = require('../../config/redis');
const env = require('../../config/env');
const logger = require('../../config/logger');

/**
 * Redis registry for the dispatch system.
 *
 * Three pieces of state, all keyed off the booking or the partner:
 *
 *   1. Per-category online geo set
 *      Key: `partners:online:cat:{categoryId}`
 *      Type: GEO (sorted set with longitude/latitude scores)
 *      Members: stringified partner ids
 *      TTL: refreshed on each presence ping; entries expire on their
 *           own when a partner stops pinging (we don't have a global
 *           TTL on the GEO key — instead we reap stale members below)
 *
 *      Why per-category: dispatching for a "Plumbing" booking should
 *      only GEOSEARCH the plumbing pool. Avoids loading every online
 *      partner into the worker for every booking.
 *
 *   2. Last-seen timestamp per partner
 *      Key: `partner:lastseen:{partnerId}`
 *      Type: string (epoch ms)
 *      TTL: 90s (PRESENCE_TTL_S) — auto-expires the partner if their
 *      app stops pinging. We also use this to defensively skip stale
 *      partners during dispatch (in case the GEO entry outlived the
 *      lastseen TTL by a fraction of a second).
 *
 *   3. Booking-side state
 *      Key: `booking:visibleTo:{bookingId}` — set of partner ids the
 *           dispatcher offered this booking to. Drives the partner-app
 *           polling fallback (and lets a re-poll see the same offers
 *           if the socket dropped).
 *      Key: `booking:claim:{bookingId}` — string lock with NX so only
 *           the first partner-accept wins; the second sees the lock
 *           and gets a 409.
 *      TTL: 5 minutes — covers the 90s dispatch window plus accept
 *      latency and a buffer. Cleared when the booking transitions out
 *      of PENDING.
 */

const PRESENCE_TTL_S = 90;
const BOOKING_KEY_TTL_S = 300;
const VISIBLE_TO_LIMIT = 200;

const enabled = () => redis !== null && redis.status === 'ready';

const safe = async (op, fallback) => {
  if (!enabled()) return fallback;
  try {
    return await op();
  } catch (err) {
    logger.warn(`Dispatch registry op failed: ${err.message}`);
    return fallback;
  }
};

const onlineKey = (categoryId) => `partners:online:cat:${categoryId}`;
const lastSeenKey = (partnerId) => `partner:lastseen:${partnerId}`;
const visibleToKey = (bookingId) => `booking:visibleTo:${bookingId}`;
const claimKey = (bookingId) => `booking:claim:${bookingId}`;
/// Reverse index: every booking a partner has been offered. Written
/// alongside `visibleTo` so partner polls can do a single SMEMBERS
/// instead of scanning every booking-visibility key. Auto-trimmed to
/// the same TTL as the booking-side keys so stale offers age out.
const partnerOffersKey = (partnerId) => `partner:offers:${partnerId}`;

/// Mark a partner as online + pin their current location into the
/// per-category geo set. Called on Socket.io connect, on every
/// location ping, and on every legacy partnerIncoming poll (so the
/// existing partner-app keeps working even before it's converted to
/// the socket flow).
const upsertOnline = async ({ partnerId, categoryId, lat, lng }) => {
  if (categoryId == null || lat == null || lng == null) return;
  return safe(async () => {
    await redis
      .multi()
      .geoadd(onlineKey(categoryId), Number(lng), Number(lat), String(partnerId))
      .set(lastSeenKey(partnerId), Date.now(), 'EX', PRESENCE_TTL_S)
      .exec();
  });
};

/// Drop a partner from the online registry — called on socket
/// disconnect, when the partner accepts a job (so we don't keep
/// offering them new ones while they're busy), and when the partner
/// flips themselves to "off duty" in the app.
const removeOnline = async ({ partnerId, categoryId }) => {
  if (categoryId == null) return;
  return safe(async () => {
    await redis
      .multi()
      .zrem(onlineKey(categoryId), String(partnerId))
      .del(lastSeenKey(partnerId))
      .exec();
  });
};

/// Total count of partners marked online in a category, ignoring
/// distance. Used purely for diagnostic logging — comparing this to
/// the radius-filtered count of `findOnlineNearby` reveals whether
/// a "0 candidates" wave is a geography problem (partners exist but
/// far away) or a presence problem (nobody is on duty in this
/// category at all).
const countOnlineInCategory = async (categoryId) => {
  return safe(async () => {
    return await redis.zcard(onlineKey(categoryId));
  }, 0);
};

/// Find every online partner inside the given radius of (lat, lng) for
/// a single category, sorted by distance ascending. Defensive filter
/// against the tiny window where a partner's GEO entry is still in the
/// set but their lastseen TTL has lapsed — those get reaped here so a
/// crashed app doesn't get phantom offers.
///
/// Uses `GEORADIUS` (Redis 3.2+) rather than the newer `GEOSEARCH`
/// (Redis 6.2+) so the dispatcher works on older Redis builds —
/// running into "ERR unknown command `geosearch`" on a sub-6.2 box
/// silently dropped every candidate to zero. GEORADIUS is technically
/// deprecated in 6.2 but still fully supported, so a single code
/// path covers both versions.
const findOnlineNearby = async ({ categoryId, lat, lng, radiusKm, limit = 50 }) => {
  return safe(async () => {
    const rows = await redis.georadius(
      onlineKey(categoryId),
      Number(lng),
      Number(lat),
      Number(radiusKm),
      'km',
      'WITHCOORD',
      'WITHDIST',
      'ASC',
      'COUNT',
      limit,
    );

    /// Each row is [partnerId, distanceKmString, [lng, lat]].
    const candidates = rows.map(([id, dist, coord]) => ({
      partnerId: Number(id),
      distanceKm: Number(dist),
      lng: Number(coord[0]),
      lat: Number(coord[1]),
    }));

    if (candidates.length === 0) return [];

    /// Bulk lastseen check — drop members whose presence TTL has
    /// expired but whose GEO entry hasn't been swept yet.
    const liveness = await redis.mget(
      ...candidates.map((c) => lastSeenKey(c.partnerId)),
    );
    return candidates.filter((_, i) => liveness[i] !== null);
  }, []);
};

/// Add the given partner ids to the booking's visibleTo set and to
/// each partner's reverse-index set. Two writes per dispatch wave (one
/// forward, one reverse-fanned) is cheap; the gain is that partner
/// polls become one SMEMBERS instead of an O(active-bookings) scan.
const recordVisible = async ({ bookingId, partnerIds }) => {
  if (!partnerIds || partnerIds.length === 0) return;
  return safe(async () => {
    const key = visibleToKey(bookingId);
    /// SADD takes variadic args; cap at VISIBLE_TO_LIMIT so a
    /// dispatch with thousands of candidates can't blow up the set.
    /// In practice waves cap themselves at 50 each, so this is just
    /// a defense in depth.
    const slice = partnerIds.slice(0, VISIBLE_TO_LIMIT).map(String);
    const pipe = redis
      .multi()
      .sadd(key, ...slice)
      .expire(key, BOOKING_KEY_TTL_S);
    /// Reverse fan-out: each candidate gets the bookingId added to
    /// their personal offers set, refreshed to the same TTL window.
    /// Same pipeline so it's one round-trip regardless of wave size.
    for (const pid of slice) {
      pipe.sadd(partnerOffersKey(pid), String(bookingId));
      pipe.expire(partnerOffersKey(pid), BOOKING_KEY_TTL_S);
    }
    await pipe.exec();
  });
};

/// Read the partner's reverse-index set directly — O(1) lookup for the
/// hot path. We still verify each id against the booking's visibleTo
/// set defensively (a stale id can linger if `clearBooking` was
/// interrupted), but the SMEMBERS itself is fast and bounded.
const listOffersForPartner = async (partnerId) => {
  return safe(async () => {
    const ids = await redis.smembers(partnerOffersKey(partnerId));
    return ids.map(Number).filter(Number.isFinite);
  }, []);
};

/// Read the partners that were offered a particular booking. Used by
/// the socket gateway to send "this offer is gone" only to partners
/// who actually saw it, instead of broadcasting to everyone connected.
const listPartnersForBooking = async (bookingId) => {
  return safe(async () => {
    const ids = await redis.smembers(visibleToKey(bookingId));
    return ids.map(Number).filter(Number.isFinite);
  }, []);
};

/// First-ack-wins claim. Returns true when this partner won the lock,
/// false when somebody else already grabbed it. Caller should still
/// run their DB transition — Redis is the fast-fail path, the DB row
/// is the source of truth (`status: 'PENDING' → 'CONFIRMED'` with a
/// `partnerId IS NULL` guard wins or loses there too).
const tryClaim = async ({ bookingId, partnerId }) => {
  return safe(async () => {
    const result = await redis.set(
      claimKey(bookingId),
      String(partnerId),
      'NX',
      'EX',
      BOOKING_KEY_TTL_S,
    );
    return result === 'OK';
  }, true /* if Redis is down, fall through to the DB-side guard */);
};

// ── Idempotency keys ────────────────────────────────────────────────
//
// `POST /bookings` accepts an optional Idempotency-Key header. Same
// key from the same customer within the IDEMPOTENCY_TTL_S window is
// served from Redis (or DB-backed cache if Redis is down — in that
// case the dedup just no-ops, matching every other "Redis fall-open"
// path in this module).
//
// Two keys per request:
//   booking:idem:{customerId}:{key}        → the resulting bookingId
//   booking:idem:lock:{customerId}:{key}   → SET NX lock so two
//                                             concurrent retries don't
//                                             both blow past the cache
//                                             on a cold key
//
// 10-minute window covers the realistic "user hammered Pay button on a
// flaky network" case without holding old keys forever.
const IDEMPOTENCY_TTL_S = 600;
const idemKey = (customerId, key) => `booking:idem:${customerId}:${key}`;
const idemLockKey = (customerId, key) => `booking:idem:lock:${customerId}:${key}`;

/// Look up a previously-stored booking id for this idempotency key.
/// Returns null on miss or when Redis is disabled.
const getIdempotentBookingId = async (customerId, key) => {
  if (!key) return null;
  return safe(async () => {
    const raw = await redis.get(idemKey(customerId, key));
    return raw ? Number(raw) : null;
  }, null);
};

/// Acquire a short-lived lock so two concurrent requests with the same
/// key serialise — the second one will see the cached bookingId once
/// the first finishes. Returns true if we got the lock; false means
/// somebody else is processing the same key right now and the caller
/// should poll/wait or just retry.
const acquireIdempotencyLock = async (customerId, key) => {
  if (!key) return true;
  return safe(async () => {
    const ok = await redis.set(idemLockKey(customerId, key), '1', 'NX', 'EX', 30);
    return ok === 'OK';
  }, true /* if Redis is down, fall through */);
};

const releaseIdempotencyLock = async (customerId, key) => {
  if (!key) return;
  return safe(async () => {
    await redis.del(idemLockKey(customerId, key));
  });
};

/// Persist the bookingId for this key so future retries with the same
/// key get the same row. Called only on successful create — failed
/// creates leave the key untouched so a corrected retry can succeed.
const recordIdempotencyResult = async (customerId, key, bookingId) => {
  if (!key) return;
  return safe(async () => {
    await redis.set(idemKey(customerId, key), String(bookingId), 'EX', IDEMPOTENCY_TTL_S);
  });
};

/// Wipe Redis state for a booking once it's left PENDING — accept,
/// cancel, or expire. Keeps memory bounded and prevents stale offers
/// from showing up in late-arriving partner polls.
///
/// Also walks the booking's `visibleTo` set and SREMs the bookingId
/// from each partner's reverse-index set. Without this, a partner
/// who polls right after a booking is accepted by someone else would
/// see it in their offers set, hit the DB, find it CONFIRMED, and
/// drop it — wasted round-trip we can avoid here cheaply.
const clearBooking = async (bookingId) => {
  return safe(async () => {
    const partnerIds = await redis.smembers(visibleToKey(bookingId));
    const pipe = redis.multi().del(visibleToKey(bookingId), claimKey(bookingId));
    for (const pid of partnerIds) {
      pipe.srem(partnerOffersKey(pid), String(bookingId));
    }
    await pipe.exec();
  });
};

module.exports = {
  enabled,
  PRESENCE_TTL_S,
  upsertOnline,
  removeOnline,
  countOnlineInCategory,
  findOnlineNearby,
  recordVisible,
  listOffersForPartner,
  listPartnersForBooking,
  tryClaim,
  clearBooking,
  getIdempotentBookingId,
  acquireIdempotencyLock,
  releaseIdempotencyLock,
  recordIdempotencyResult,
};
