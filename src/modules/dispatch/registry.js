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
 *      TTL: 5 minutes — covers the 190s dispatch window plus accept
 *      latency and a buffer. Cleared when the booking transitions out
 *      of PENDING.
 */

const PRESENCE_TTL_S = 90;
/// "Sticky" presence TTL for an EXPLICITLY on-duty partner. Live presence
/// pings use the short 90s TTL (so a crashed app drops quickly), but the
/// explicit On Duty toggle registers the partner with this MUCH longer
/// TTL so they STAY in the dispatch pool while backgrounded — on OEMs
/// (Vivo/Oppo/Xiaomi) that freeze the JS thread, pings stop within
/// seconds and the 90s TTL would otherwise drop a partner who is very
/// much still on duty. They're removed on explicit Off Duty; this TTL is
/// just the safety net for "forgot to go off duty" (4h covers a shift).
const STICKY_ONLINE_TTL_S = 4 * 60 * 60;
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
/// Authoritative "partner explicitly went off duty" flag. Set by the
/// duty endpoint when the partner toggles OFF, cleared when they toggle
/// ON. While present, `upsertOnline` refuses to re-add the partner to
/// the online geo set — this is what closes the reconnect-after-
/// location-change race where a socket reconnect or background poll
/// would otherwise re-register an off-duty partner as available.
///
/// Long TTL (12h) so the flag outlives any reconnect storm, app
/// relaunch, or background poll cycle; a partner coming back on duty
/// clears it explicitly, and a stale flag from a partner who never
/// returns simply ages out so it can't pin them off-duty forever.
const OFFDUTY_TTL_S = 12 * 60 * 60;
const offDutyKey = (partnerId) => `partner:offduty:${partnerId}`;
/// "Partner is on an active accepted job" flag. Set when a partner
/// accepts a booking, cleared when that job completes or is cancelled.
/// While present, `upsertOnline` refuses to re-add the partner to the
/// online geo set — so a partner who keeps sending presence pings while
/// driving to / doing a job is NOT offered (push + socket) new jobs.
/// `removeOnline` on accept pulls them out once; this flag is what keeps
/// them out against their own 15s presence re-adds.
///
/// TTL is a safety net: if the clear-on-complete somehow doesn't fire
/// (crash, missed webhook), the flag ages out so the partner isn't
/// pinned "busy" forever. 4h comfortably covers any real job.
const ACTIVE_JOB_TTL_S = 4 * 60 * 60;
const activeJobKey = (partnerId) => `partner:active:${partnerId}`;
const visibleToKey = (bookingId) => `booking:visibleTo:${bookingId}`;
const claimKey = (bookingId) => `booking:claim:${bookingId}`;
/// Partners who DECLINED / cancelled this specific booking — they must
/// not be re-offered it on subsequent waves (a partner who walked away
/// from a job shouldn't get re-alerted for the same one). Per-booking
/// set, aged out with the booking-side TTL.
const declinedKey = (bookingId) => `booking:declined:${bookingId}`;
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
/// Legacy partner-app builds defaulted presence to this exact
/// Bengaluru/HSR coordinate when GPS was cold, which registered
/// far-away partners inside the dispatch radius of HSR-area bookings.
/// The app no longer sends it (it now skips presence without a real
/// fix), but we reject it server-side too so any un-updated build in
/// the wild can't keep poisoning the geo set. The tiny epsilon guards
/// against float-format drift in the exact constant.
const SENTINEL_DEFAULT_LAT = 12.9352;
const SENTINEL_DEFAULT_LNG = 77.6245;
const isSentinelDefaultCoord = (lat, lng) =>
  Math.abs(Number(lat) - SENTINEL_DEFAULT_LAT) < 1e-4 &&
  Math.abs(Number(lng) - SENTINEL_DEFAULT_LNG) < 1e-4;

const upsertOnline = async ({ partnerId, categoryId, lat, lng }) => {
  if (categoryId == null || lat == null || lng == null) return;
  /// Reject the known hardcoded default — see isSentinelDefaultCoord.
  /// A real partner who happens to be within ~11m of this exact point
  /// will be re-registered by their next genuine fix moments later, so
  /// dropping this one ping is harmless.
  if (isSentinelDefaultCoord(lat, lng)) return;
  return safe(async () => {
    /// HARD GATES — never re-register a partner who is either:
    ///   (a) explicitly OFF DUTY, or
    ///   (b) on an ACTIVE accepted job (busy).
    /// Every presence path (socket `presence`, legacy partnerIncoming
    /// poll, background task) funnels through here, so these two checks
    /// block ALL of them. (b) is what stops a partner from getting NEW
    /// job offers (push + socket) while they're still finishing the job
    /// they accepted — their app keeps pinging presence as they drive,
    /// and without this they'd be re-added to the pool ~15s after accept.
    /// One EXISTS over both keys keeps this a single round-trip.
    const blocked = await redis.exists(offDutyKey(partnerId), activeJobKey(partnerId));
    if (blocked > 0) {
      /// TEMP DIAGNOSTIC — remove once "no job alert" is resolved.
      logger.info(`[presence-debug] upsertOnline BLOCKED partner ${partnerId}: offduty/active flag set (exists=${blocked})`);
      return;
    }
    await redis
      .multi()
      .geoadd(onlineKey(categoryId), Number(lng), Number(lat), String(partnerId))
      /// Use the STICKY TTL (not 90s): any presence ping means the
      /// partner is on duty, and we want them to survive the app being
      /// backgrounded/frozen between pings. They're removed on explicit
      /// Off Duty; the long TTL is just the "forgot to go off" safety net.
      .set(lastSeenKey(partnerId), Date.now(), 'EX', STICKY_ONLINE_TTL_S)
      .exec();
    logger.info(`[presence-debug] upsertOnline DONE partner ${partnerId} → cat:${categoryId} geoadd OK`);
  });
};

/// Register an EXPLICITLY on-duty partner into the dispatch pool with a
/// LONG (sticky) lastseen TTL, so they stay matchable while the app is
/// backgrounded and pings have paused (OEM JS-thread freeze). Called from
/// the duty endpoint on toggle-ON. Skips a partner mid-job (active flag)
/// so we don't make a busy partner re-eligible. The off-duty flag was
/// just cleared by the toggle, so we don't re-check it here.
const setStickyOnline = async ({ partnerId, categoryId, lat, lng }) => {
  if (categoryId == null || lat == null || lng == null) return;
  if (isSentinelDefaultCoord(lat, lng)) return;
  return safe(async () => {
    if ((await redis.exists(activeJobKey(partnerId))) > 0) return; // busy → leave out
    await redis
      .multi()
      .geoadd(onlineKey(categoryId), Number(lng), Number(lat), String(partnerId))
      .set(lastSeenKey(partnerId), Date.now(), 'EX', STICKY_ONLINE_TTL_S)
      .exec();
    logger.info(`[presence-debug] setStickyOnline partner ${partnerId} → cat:${categoryId} (sticky ${STICKY_ONLINE_TTL_S}s)`);
  });
};

/// Mark a partner explicitly OFF duty: set the guard flag AND remove
/// them from the online registry in one shot, so dispatch stops
/// offering to them immediately (not after the 90s presence TTL). The
/// flag then prevents any racing presence ping from re-adding them.
/// `categoryId` is optional — the flag is category-independent, and we
/// best-effort ZREM from the category set when we know it.
const setOffDuty = async ({ partnerId, categoryId = null }) => {
  return safe(async () => {
    const pipe = redis.multi().set(offDutyKey(partnerId), Date.now(), 'EX', OFFDUTY_TTL_S);
    if (categoryId != null) pipe.zrem(onlineKey(categoryId), String(partnerId));
    pipe.del(lastSeenKey(partnerId));
    await pipe.exec();
  });
};

/// Clear the off-duty flag when a partner comes back ON duty. The next
/// presence ping (fired immediately by the app on toggle-on) then
/// re-adds them to the online set via `upsertOnline`.
const clearOffDuty = async (partnerId) => {
  return safe(async () => {
    await redis.del(offDutyKey(partnerId));
  });
};

/// Whether a partner currently holds the explicit off-duty flag. Used
/// by the legacy poll path to short-circuit before doing any work.
const isOffDuty = async (partnerId) => {
  return safe(async () => {
    return (await redis.exists(offDutyKey(partnerId))) === 1;
  }, false);
};

/// Mark a partner as ON an active job (busy). Set on accept so they
/// stop being offered new jobs while they finish the current one. The
/// flag + `removeOnline` together pull them out and keep them out
/// against their own presence pings. TTL is a self-healing safety net.
const setActiveJob = async (partnerId) => {
  return safe(async () => {
    await redis.set(activeJobKey(partnerId), Date.now(), 'EX', ACTIVE_JOB_TTL_S);
  });
};

/// Clear the busy flag when the job completes / is cancelled, so the
/// partner's next presence ping re-adds them to the dispatch pool.
const clearActiveJob = async (partnerId) => {
  return safe(async () => {
    await redis.del(activeJobKey(partnerId));
  });
};

/// Whether a partner is currently on an active job. Used by the legacy
/// poll path as a fast short-circuit (the DB `partnerHasActiveJob` is
/// the authoritative check; this avoids the query on the hot path).
const isOnActiveJob = async (partnerId) => {
  return safe(async () => {
    return (await redis.exists(activeJobKey(partnerId))) === 1;
  }, false);
};

/// Change-detector for the DB `onDuty` MIRROR. Presence pings arrive
/// every ~15s, but we only want to write the partner row when the duty
/// state actually FLIPS — otherwise we'd hammer Postgres with a write
/// per ping (the exact load the Redis-first design avoids). We cache the
/// last-mirrored value in Redis and return true only when `onDuty`
/// differs from it (then store the new value). Returns true when Redis
/// is down so the caller still attempts the write (correctness over
/// write-amplification during an outage).
const dutyMirrorKey = (partnerId) => `partner:dutymirror:${partnerId}`;
const shouldMirrorDuty = async (partnerId, onDuty) => {
  return safe(async () => {
    const want = onDuty ? '1' : '0';
    const prev = await redis.get(dutyMirrorKey(partnerId));
    if (prev === want) return false;
    /// Long TTL so the cache survives normal operation; if it expires
    /// the next ping just re-writes the DB once (harmless idempotent).
    await redis.set(dutyMirrorKey(partnerId), want, 'EX', 24 * 60 * 60);
    return true;
  }, true);
};

/// Clear the duty-mirror change-cache for a partner — called by the
/// stale-onDuty reconciler after it flips a ghost row to false, so the
/// partner's NEXT presence ping is seen as a real transition and
/// re-writes onDuty=true (otherwise the cache would still say '1' and
/// the change-gate would skip the write).
const clearDutyMirror = async (partnerId) => {
  return safe(async () => {
    await redis.del(dutyMirrorKey(partnerId));
  });
};

/// Given partner ids, return the SUBSET currently on an active job.
/// Used by the dispatcher to drop busy partners from a wave's candidate
/// list as defense-in-depth (the upsertOnline guard already keeps them
/// out of the geo set, but a flag set mid-wave or a missed removeOnline
/// could leave one in — this is the belt to that suspenders). Empty Set
/// when Redis is down so the dispatcher fails open (offers go out; the
/// DB-side guards on accept still prevent a double-assignment).
const filterActivePartnerIds = async (partnerIds) => {
  if (!Array.isArray(partnerIds) || partnerIds.length === 0) return new Set();
  return safe(async () => {
    const values = await redis.mget(...partnerIds.map((id) => activeJobKey(id)));
    const busy = new Set();
    partnerIds.forEach((id, i) => {
      if (values[i] != null) busy.add(Number(id));
    });
    return busy;
  }, new Set());
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

/// Throttle gate for mirroring on-duty presence coordinates into the
/// DB (`partner.currentLat/Lng`). Presence pings arrive every ~15s, but
/// we don't want a DB write that often per partner — once a minute is
/// plenty to keep admin "nearby partners" + the accept-time fallback
/// fresh. Uses `SET key NX EX 60`: returns true only when the key was
/// absent (i.e. >60s since the last mirror for this partner), at which
/// point the caller does the DB write. Fails OPEN (returns true) when
/// Redis is down so we don't silently stop mirroring — a few extra DB
/// writes during a Redis outage are harmless.
const LOCATION_MIRROR_THROTTLE_S = 60;
const locationMirrorKey = (partnerId) => `partner:locmirror:${partnerId}`;
const shouldMirrorLocation = async (partnerId) => {
  return safe(async () => {
    const res = await redis.set(
      locationMirrorKey(partnerId),
      Date.now(),
      'EX',
      LOCATION_MIRROR_THROTTLE_S,
      'NX',
    );
    return res === 'OK';
  }, true);
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

/// Given a list of partner ids, return the SUBSET that is currently
/// on duty — i.e. has a live `lastseen` key (refreshed on every 15s
/// presence ping while the app is on-duty, independent of whether
/// they're on an active job). Used by the admin manual-dispatch
/// modal to badge + sort On Duty partners. Returns an empty Set when
/// Redis is disabled (presence isn't tracked) so callers fall back
/// to whatever they consider the default — better than blocking.
const filterOnlinePartnerIds = async (partnerIds) => {
  if (!Array.isArray(partnerIds) || partnerIds.length === 0) return new Set();
  return safe(async () => {
    const keys = partnerIds.map((id) => lastSeenKey(id));
    const values = await redis.mget(...keys);
    const online = new Set();
    partnerIds.forEach((id, i) => {
      if (values[i] != null) online.add(Number(id));
    });
    return online;
  }, new Set());
};

// ── Live socket presence (cross-instance, for FCM gating) ───────────
//
// A per-partner counter of currently-open sockets ACROSS every API
// instance. Distinct from the lastseen/online geo set (a 90s "recently
// pinged" signal): this is real-time socket liveness, used by the
// dispatcher to decide whether a partner will receive the in-app
// `dispatch.offer` — so the hybrid FCM push can be skipped for them and
// nobody gets double-alerted. INCR on connect, DECR on disconnect; the
// short TTL (refreshed on every presence ping) means a crashed
// instance's counters self-heal instead of pinning a partner
// "connected" forever. Replaces the old in-memory Map that only knew
// about sockets on the local process.
const SOCKET_CONN_TTL_S = 120;
const socketConnKey = (partnerId) => `partner:sock:${partnerId}`;

const incrSocketConn = async (partnerId) =>
  safe(async () => {
    const key = socketConnKey(partnerId);
    const n = await redis.incr(key);
    await redis.expire(key, SOCKET_CONN_TTL_S);
    return n;
  }, 1);

/// Refresh the TTL so a long-lived socket's counter doesn't expire out
/// from under it. Called on each presence ping (cheap, no DB).
const touchSocketConn = async (partnerId) =>
  safe(async () => {
    await redis.expire(socketConnKey(partnerId), SOCKET_CONN_TTL_S);
  });

const decrSocketConn = async (partnerId) =>
  safe(async () => {
    const key = socketConnKey(partnerId);
    const n = await redis.decr(key);
    if (n <= 0) await redis.del(key);
    return Math.max(0, n);
  }, 0);

/// Given partner ids, return the SUBSET with at least one live socket.
/// Empty Set when Redis is down — callers then send the push (a possible
/// duplicate beats a missed job).
const connectedPartnerIds = async (partnerIds) => {
  if (!Array.isArray(partnerIds) || partnerIds.length === 0) return new Set();
  return safe(async () => {
    const values = await redis.mget(...partnerIds.map(socketConnKey));
    const set = new Set();
    partnerIds.forEach((id, i) => {
      if (values[i] != null && Number(values[i]) > 0) set.add(Number(id));
    });
    return set;
  }, new Set());
};

/// Return live { lat, lng } for each given partner from the category's
/// GEO set, as a Map<partnerId, { lat, lng }>. This is the partner's
/// real-time location as of their last presence ping — the accurate
/// source for "how far is this partner from the booking" in the admin
/// manual-dispatch modal. Partners not in the set (off-duty, never
/// pinged) simply won't appear in the returned Map; the caller falls
/// back to the DB's last-known `currentLat/Lng`. Returns an empty Map
/// when Redis is disabled.
const getOnlinePositions = async (categoryId, partnerIds) => {
  if (categoryId == null || !Array.isArray(partnerIds) || partnerIds.length === 0) {
    return new Map();
  }
  return safe(async () => {
    /// GEOPOS returns [[lng, lat], null, ...] aligned to the member
    /// order we pass. Null entries = member not in the set.
    const positions = await redis.geopos(
      onlineKey(categoryId),
      ...partnerIds.map(String),
    );
    const map = new Map();
    partnerIds.forEach((id, i) => {
      const pos = positions[i];
      if (pos && pos[0] != null && pos[1] != null) {
        map.set(Number(id), { lat: Number(pos[1]), lng: Number(pos[0]) });
      }
    });
    return map;
  }, new Map());
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

/// Distance (km) to the NEAREST online partner of ANY category within
/// `radiusKm` of (lat, lng), or null if none are online nearby. Powers the
/// customer home "X mins away" arrival-promise badge — a general "someone
/// can reach you" signal, not tied to a specific service. Scans every
/// `partners:online:cat:*` pool with GEORADIUS COUNT 1 (cheap: a handful of
/// small reads), takes the global minimum, and verifies the winner is still
/// live (lastseen present) so a stale geo entry can't fake a low ETA.
const nearestOnlinePartnerKm = async ({ lat, lng, radiusKm = 10 }) => {
  return safe(async () => {
    const pools = await redis.keys(onlineKey('*'));
    if (!pools || pools.length === 0) return null;

    /// Closest candidate per pool, then dedupe to the global nearest.
    const candidates = [];
    for (const key of pools) {
      const rows = await redis.georadius(
        key,
        Number(lng),
        Number(lat),
        Number(radiusKm),
        'km',
        'WITHDIST',
        'ASC',
        'COUNT',
        3, // a few per pool so a stale top entry doesn't block a live one
      );
      for (const [id, dist] of rows) {
        candidates.push({ partnerId: Number(id), distanceKm: Number(dist) });
      }
    }
    if (candidates.length === 0) return null;

    candidates.sort((a, b) => a.distanceKm - b.distanceKm);
    /// Liveness gate: walk nearest-first, return the first with a fresh
    /// lastseen key. Cap the check at the closest few to keep it O(1)-ish.
    const top = candidates.slice(0, 10);
    const live = await redis.mget(...top.map((c) => lastSeenKey(c.partnerId)));
    for (let i = 0; i < top.length; i += 1) {
      if (live[i] !== null) return top[i].distanceKm;
    }
    return null;
  }, null);
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

/// Record that a partner DECLINED / cancelled this booking — they won't
/// be re-offered it on later waves. Aged out with the booking TTL.
const addDeclinedPartner = async (bookingId, partnerId) => {
  return safe(async () => {
    await redis
      .multi()
      .sadd(declinedKey(bookingId), String(partnerId))
      .expire(declinedKey(bookingId), BOOKING_KEY_TTL_S)
      .exec();
  });
};

/// The set of partner ids who declined/cancelled this booking. Used by
/// the wave handler to filter them out of the candidate list.
const getDeclinedPartners = async (bookingId) => {
  return safe(async () => {
    const ids = await redis.smembers(declinedKey(bookingId));
    return new Set(ids.map(Number).filter(Number.isFinite));
  }, new Set());
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
  setStickyOnline,
  removeOnline,
  setOffDuty,
  clearOffDuty,
  isOffDuty,
  setActiveJob,
  clearActiveJob,
  isOnActiveJob,
  filterActivePartnerIds,
  shouldMirrorLocation,
  shouldMirrorDuty,
  clearDutyMirror,
  countOnlineInCategory,
  filterOnlinePartnerIds,
  incrSocketConn,
  decrSocketConn,
  touchSocketConn,
  connectedPartnerIds,
  getOnlinePositions,
  findOnlineNearby,
  nearestOnlinePartnerKm,
  recordVisible,
  listOffersForPartner,
  listPartnersForBooking,
  addDeclinedPartner,
  getDeclinedPartners,
  tryClaim,
  clearBooking,
  getIdempotentBookingId,
  acquireIdempotencyLock,
  releaseIdempotencyLock,
  recordIdempotencyResult,
};
