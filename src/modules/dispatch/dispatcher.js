const { Worker } = require('bullmq');
const couponsService = require('../coupons/coupons.service');
const razorpayService = require('../payments/razorpay.service');
const prisma = require('../../config/prisma');
const { withDbRetry } = require('../../config/prisma');
const logger = require('../../config/logger');
const queue = require('./queue');
const registry = require('./registry');
const { sendJobOfferPushes, clearJobOfferPush } = require('../notifications/push.service');

/**
 * BullMQ-driven dispatch — Phase 2 of the dispatcher rewrite.
 *
 * Replaces the lazy `expireBroadcasts()` + per-poll haversine model
 * with a push-style flow:
 *
 *   1. `bookings.create` enqueues seven delayed jobs:
 *        wave 1 → fires at +0   s   (3 km)
 *        wave 2 → fires at +32  s   (3 km retry)
 *        wave 3 → fires at +64  s   (5 km)
 *        wave 4 → fires at +96  s   (5 km retry)
 *        wave 5 → fires at +128 s   (7 km)
 *        wave 6 → fires at +160 s   (7 km retry)
 *        expire → fires at +190 s   (manual-dispatch handoff if still PENDING)
 *
 *      Scheduled (non-instant) bookings shift the timeline so the
 *      first wave fires `SCHEDULE_DISPATCH_LEAD_MS` before the slot
 *      starts. We compute the absolute fire times here and BullMQ
 *      handles the delay precisely.
 *
 *   2. The wave handler:
 *        - pulls the booking + items
 *        - GEOSEARCHes `partners:online:cat:{categoryId}` for each
 *          item-category (deduped) within the wave's radius
 *        - drops partners who already have an active job: the
 *          `partner:active:{id}` flag (set on accept, cleared on
 *          complete/cancel) keeps them out of the geo set via the
 *          upsertOnline guard, and handleWave filters the candidate
 *          list against it as defense-in-depth
 *        - SADDs survivors to `booking:visibleTo:{bookingId}`
 *        - emits a `dispatch.offer` event to each candidate's socket
 *          (when connected) and writes to the booking's wave columns
 *          for the polling-fallback partner-app
 *
 *   3. The expire handler:
 *        - re-reads the booking
 *        - if still PENDING + unassigned, transitions to
 *          `needs_admin_dispatch` so ops can assign manually
 *        - clears the Redis booking keys
 *
 * Idempotency: the queue uses `wave:{bookingId}:{n}` and
 * `expire:{bookingId}` job ids, so a process restart that replays
 * pending jobs won't double-fire. The DB transition uses
 * `updateMany({ where: { status: 'PENDING', partnerId: null } })`
 * so a wave that fires after a partner already accepted is a no-op.
 */

/// Dispatch cadence: every radius gets one 30s attempt, then a 2s
/// quiet gap, then one retry at the same radius before the next ring
/// opens. The retry waves deliberately re-emit socket/push alerts to
/// the same eligible partners instead of only widening the search.
///
///   Wave 1 (0:00)   — 3km initial attempt, 30s active
///   Wave 2 (0:32)   — 3km retry attempt, 30s active
///   Wave 3 (1:04)   — 5km initial attempt, 30s active
///   Wave 4 (1:36)   — 5km retry attempt, 30s active
///   Wave 5 (2:08)   — 7km initial attempt, 30s active
///   Wave 6 (2:40)   — 7km retry attempt, 30s active
///   Expiry (3:10)   — booking flips to `needs_admin_dispatch`,
///                     ops takes over from here.
const DISPATCH_WINDOW_MS = 30 * 1000;
const DISPATCH_RETRY_GAP_MS = 2 * 1000;
const DISPATCH_STEP_MS = DISPATCH_WINDOW_MS + DISPATCH_RETRY_GAP_MS;
const DISPATCH_WAVES = [
  { wave: 1, radiusKm: 3, offsetMs: 0, retry: false },
  { wave: 2, radiusKm: 3, offsetMs: DISPATCH_STEP_MS, retry: true },
  { wave: 3, radiusKm: 5, offsetMs: DISPATCH_STEP_MS * 2, retry: false },
  { wave: 4, radiusKm: 5, offsetMs: DISPATCH_STEP_MS * 3, retry: true },
  { wave: 5, radiusKm: 7, offsetMs: DISPATCH_STEP_MS * 4, retry: false },
  { wave: 6, radiusKm: 7, offsetMs: DISPATCH_STEP_MS * 5, retry: true },
];
const FINAL_DISPATCH_WAVE = DISPATCH_WAVES[DISPATCH_WAVES.length - 1];
const DISPATCH_TOTAL_MS = FINAL_DISPATCH_WAVE.offsetMs + DISPATCH_WINDOW_MS;

/// BYOP ("Book at your price") broadcasts get exactly TWO attempts —
/// one initial broadcast + one final retry — BOTH at the widest
/// configured radius (stage 2) so every eligible partner is reached
/// both times. After the second attempt the expire job stops dispatch
/// completely and the customer sees the +₹ price-bump options.
///
/// Rationale: the 6-wave widening ladder re-alerted partners inside
/// the smallest ring up to SIX times for one BYOP booking (every wave
/// includes them again) — partners reported 3-4 duplicate job alerts
/// at a price they'd already ignored. Two attempts is the configured
/// retry limit for price offers; a higher price is a NEW booking.
const BYOP_DISPATCH_WAVES = [
  { wave: 1, radiusKm: 7, stage: 2, offsetMs: 0, retry: false },
  { wave: 2, radiusKm: 7, stage: 2, offsetMs: DISPATCH_STEP_MS, retry: true },
];
const BYOP_FINAL_WAVE = BYOP_DISPATCH_WAVES[BYOP_DISPATCH_WAVES.length - 1];
const BYOP_DISPATCH_TOTAL_MS = BYOP_FINAL_WAVE.offsetMs + DISPATCH_WINDOW_MS;

/// Wave plan + total window for a booking. BYOP (offeredPrice set)
/// gets the two-attempt plan; everything else keeps the 6-wave ladder.
const isByopBooking = (booking) => booking.offeredPrice != null;
const wavePlanFor = (booking) => (isByopBooking(booking) ? BYOP_DISPATCH_WAVES : DISPATCH_WAVES);
const dispatchTotalMsFor = (booking) =>
  isByopBooking(booking) ? BYOP_DISPATCH_TOTAL_MS : DISPATCH_TOTAL_MS;

/// The 6 waves widen in 3 STAGES (initial + retry per radius). This maps a
/// wave number to its stage index (0,1,2) so we can look up the admin-
/// configured radius for that stage: waves 1-2 → stage 0, 3-4 → 1, 5-6 → 2.
const waveRadiusStage = (waveNumber) => Math.floor((waveNumber - 1) / 2);

/// Resolve a wave's radius from the admin-editable dispatch config
/// (policy.getDispatch → { radii:[r0,r1,r2] }). Falls back to the wave's
/// hardcoded `radiusKm` if settings are unavailable, so dispatch never
/// breaks on a settings read error. Loaded fresh per wave (cheap single-
/// row read) so an admin radius change takes effect on the next booking
/// without a restart.
const resolveWaveRadiusKm = async (waveSpec) => {
  try {
    const { radii } = await require('../policy/policy.service').getDispatch();
    /// BYOP wave specs pin their stage explicitly (both attempts use the
    /// widest ring); the standard ladder derives it from the wave number.
    const stage = waveSpec.stage ?? waveRadiusStage(waveSpec.wave);
    const r = radii?.[stage];
    return Number.isFinite(r) && r > 0 ? r : waveSpec.radiusKm;
  } catch {
    return waveSpec.radiusKm;
  }
};
// Lead time before a scheduled slot at which dispatch begins. MUST stay
// in sync with the same constant in bookings.service.js.
const SCHEDULE_DISPATCH_LEAD_MS = 30 * 60 * 1000;
/// When all six waves elapse without acceptance, the booking is
/// handed off to admin (status stays PENDING, dispatchStatus flips
/// to `needs_admin_dispatch`). This is how long admin has to take
/// action before a safety-net auto-cancel kicks in. Keep this long
/// enough to span a typical work-day handover, short enough that a
/// forgotten booking doesn't sit in limbo for days.
const ADMIN_DISPATCH_GRACE_MS = 2 * 60 * 60 * 1000;

let worker = null;
let socketEmitter = null;

/// Allow the socket gateway to register itself for offer pushes.
/// Decoupled so the dispatcher module doesn't import socket.io
/// (avoids a circular import when the gateway needs the dispatcher).
const setSocketEmitter = (fn) => {
  socketEmitter = fn;
};

/// True when the partner has at least one live socket right now —
/// resolved from the cross-instance Redis counter (set by the socket
/// gateway's connect/disconnect handlers), so it's correct no matter
/// which API instance the partner is connected to. Used to suppress the
/// hybrid FCM fallback for partners who'll get the in-app `dispatch.offer`
/// (avoids double-alerting). Async now; callers await it.
const isPartnerConnected = async (partnerId) => {
  const set = await registry.connectedPartnerIds([Number(partnerId)]);
  return set.has(Number(partnerId));
};

/// Computes the moment dispatch starts for a booking. For instant
/// bookings (and BYOP offers) it's `createdAt`; for scheduled jobs
/// it's `scheduledAt - 30min` so a partner has lead time to start
/// driving before the slot opens.
const dispatchStartAt = (booking) => {
  if (booking.isInstant || booking.offeredPrice != null) {
    return new Date(booking.createdAt);
  }
  return new Date(new Date(booking.scheduledAt).getTime() - SCHEDULE_DISPATCH_LEAD_MS);
};

/// Schedule all dispatch jobs for a booking. Called from bookings.create
/// right after the row is inserted. Negative delays (i.e. dispatch
/// should already have started — happens for scheduled bookings whose
/// dispatch lead-time has already passed by the time of insert) are
/// clamped to 0 so the wave runs immediately.
const scheduleAllForBooking = async (booking) => {
  if (!queue.enabled()) return;
  const start = dispatchStartAt(booking).getTime();
  const now = Date.now();

  /// BYOP → 2 attempts then stop; everything else → the 6-wave ladder.
  for (const w of wavePlanFor(booking)) {
    const delay = Math.max(0, start + w.offsetMs - now);
    await queue.enqueueWave(booking.id, w.wave, delay);
  }
  const expireDelay = Math.max(0, start + dispatchTotalMsFor(booking) - now);
  await queue.enqueueExpire(booking.id, expireDelay);
};

/// Cancel scheduled jobs for a booking — used when a partner accepts
/// (no need for later waves or the expirer to fire) or when admin
/// cancels manually.
const cancelAllForBooking = async (bookingId) => {
  if (!queue.enabled()) return;
  await queue.cancelJobsForBooking(bookingId);
  await registry.clearBooking(bookingId);
};

/// Schedule the BYOP pay-after-accept timer. Called from
/// bookings.partnerAccept when a partner accepts a booking that has
/// `offeredPrice` set. Cancelled implicitly via job-id idempotency
/// once payment lands and the booking is no longer PENDING-pay
/// (the worker checks status at fire time).
const schedulePaymentExpire = async (bookingId, delayMs) => {
  if (!queue.enabled()) return;
  await queue.enqueuePaymentExpire(bookingId, delayMs);
};

/// Targeted "this offer is gone" broadcast — emits dispatch.claimed
/// only to partners who actually saw the booking, skipping the
/// accepter (their UI already knows). Caller is expected to have
/// snapshotted the audience BEFORE calling cancelAllForBooking,
/// which wipes the visibleTo set the audience comes from.
const broadcastClaimed = (audience, payload) => {
  if (!audience || audience.length === 0) return;
  /// Close the in-app offer on every CONNECTED partner (socket).
  if (socketEmitter) {
    for (const pid of audience) {
      if (pid === payload.partnerId) continue;
      socketEmitter('dispatch.claimed', pid, payload);
    }
  }
  /// Clear the OS notification on BACKGROUNDED partners (FCM) too — they
  /// have no live socket, so without this the "New job" push lingers in
  /// their bar after the job is taken. Skip the accepter. Fire-and-forget.
  const others = audience.filter((pid) => pid !== payload.partnerId);
  if (others.length > 0 && payload.bookingId != null) {
    void clearJobOfferPush(prisma, others, payload.bookingId);
  }
};

/// Emit an event straight to one partner's connected sockets. Used for
/// admin-assigned jobs (`job.assigned`) so the partner-app can ring the
/// "New job assigned" alert without going through the broadcast/offer
/// path. No-op when the socket gateway isn't wired or the partner has
/// no live socket (the FCM push from the caller covers that case).
const emitToPartner = (partnerId, event, payload) => {
  if (!socketEmitter || partnerId == null) return;
  socketEmitter(event, Number(partnerId), payload);
};

/// Emit an event to one customer's connected sockets (the `customer:{id}`
/// room). Used to push live booking-lifecycle updates — e.g. "partner
/// arrived" — so the customer-app's tracking screen updates instantly
/// instead of waiting for its next poll. No-op when the gateway isn't
/// wired or the customer has no live socket (the app's poll catches up).
const emitToCustomer = (customerId, event, payload) => {
  if (!socketEmitter || customerId == null) return;
  socketEmitter(event, `customer:${Number(customerId)}`, payload);
};

/// One wave: find candidates, mark them visible, push to sockets.
const handleWave = async ({ bookingId, wave: waveNumber }) => {
  /// Re-read the booking — the row may have transitioned out of
  /// PENDING since we were enqueued (partner accepted, admin
  /// cancelled, or the previous wave expired into CANCELLED).
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      partnerId: true,
      lat: true,
      lng: true,
      offeredPrice: true,
      isInstant: true,
      scheduledAt: true,
      createdAt: true,
      total: true,
      /// `grandTotal` (customer-facing all-in) is what the partner-app
      /// renders inside the job-request screen — surface the SAME number
      /// in the push payload so the notification doesn't say one price
      /// (₹1583 / `total`) and the in-app screen another (₹1899 /
      /// `grandTotal`).
      grandTotal: true,
      /// Address fields for the socket payload's `address` — without
      /// these in the select, the fallback chain below always resolved
      /// to '' and the partner app sat on "Loading address…" until its
      /// HTTP refresh (~3-5s) filled it in.
      addressLine: true,
      addressLabel: true,
      customerAddress: { select: { addressLine: true } },
      items: {
        select: {
          service: { select: { categoryId: true, name: true } },
        },
      },
    },
  });
  if (!booking) return;
  if (booking.status !== 'PENDING' || booking.partnerId != null) return;
  if (booking.lat == null || booking.lng == null) return;

  /// Resolve the wave spec from THIS booking's plan (BYOP = 2 attempts
  /// at the widest ring, standard = 6-wave ladder).
  const waveSpec = wavePlanFor(booking).find((w) => w.wave === waveNumber);
  if (!waveSpec) return;

  /// Admin-configurable radius for this wave's stage (3/5/7km by default,
  /// editable from the admin Dispatch Rules page). Resolved fresh here so
  /// a change applies to the next wave without a restart.
  const radiusKm = await resolveWaveRadiusKm(waveSpec);

  /// Distinct categories — usually one, occasionally a multi-category
  /// cart. We GEOSEARCH each pool independently and union the results.
  const categoryIds = [...new Set(booking.items.map((i) => i.service.categoryId))];
  if (categoryIds.length === 0) return;

  /// Diagnostic header — every wave logs the booking's anchor +
  /// radius + categories it's searching against. Makes it trivial to
  /// see whether a "0 candidates" result is a geography mismatch
  /// (lat/lng nowhere near any online partner) vs. a category
  /// mismatch (booking is Electrician but no online partner has
  /// that categoryId) vs. nobody on duty at all.
  logger.info(
    `dispatch wave ${waveNumber} for booking ${bookingId}: ` +
      `anchor=(${booking.lat}, ${booking.lng}) radius=${radiusKm}km ` +
      `retry=${waveSpec.retry ? 'yes' : 'no'} ` +
      `categories=[${categoryIds.join(',')}]`,
  );

  const seen = new Set();
  const candidates = [];
  for (const cat of categoryIds) {
    /// Pool size (all online partners in this category, no distance
    /// filter) vs. nearby (filtered to this wave's radius). The
    /// gap between the two is the geographic-mismatch signal.
    const poolSize = await registry.countOnlineInCategory(cat).catch(() => 'n/a');
    const rows = await registry.findOnlineNearby({
      categoryId: cat,
      lat: booking.lat,
      lng: booking.lng,
      radiusKm,
      limit: 50,
    });
    logger.info(
      `  category ${cat}: pool=${poolSize} online, ` +
        `${rows.length} within ${radiusKm}km` +
        (rows.length > 0
          ? ` -> ${rows.map((r) => `#${r.partnerId}@${r.distanceKm.toFixed(2)}km`).join(', ')}`
          : ''),
    );
    for (const r of rows) {
      if (seen.has(r.partnerId)) continue;
      seen.add(r.partnerId);
      candidates.push(r);
    }
  }

  /// Defense-in-depth: drop any candidate currently on an active job.
  /// The upsertOnline guard already keeps busy partners OUT of the geo
  /// set, so this normally removes nothing — but it's the belt to that
  /// suspenders against a missed removeOnline / a flag set mid-wave, so
  /// a partner finishing a job never gets a NEW push/socket offer.
  if (candidates.length > 0) {
    const busy = await registry
      .filterActivePartnerIds(candidates.map((c) => c.partnerId))
      .catch(() => new Set());
    if (busy.size > 0) {
      const before = candidates.length;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        if (busy.has(candidates[i].partnerId)) candidates.splice(i, 1);
      }
      logger.info(
        `dispatch wave ${waveNumber} for booking ${bookingId}: dropped ${before - candidates.length} busy partner(s)`,
      );
    }
  }

  /// Drop partners who DECLINED / cancelled THIS booking — they walked
  /// away from it, so they must never be re-offered the same job on a
  /// later wave (the "same partner gets re-alerted after cancelling" bug).
  if (candidates.length > 0) {
    const declined = await registry.getDeclinedPartners(bookingId).catch(() => new Set());
    if (declined.size > 0) {
      const before = candidates.length;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        if (declined.has(candidates[i].partnerId)) candidates.splice(i, 1);
      }
      if (before !== candidates.length) {
        logger.info(
          `dispatch wave ${waveNumber} for booking ${bookingId}: dropped ${before - candidates.length} declined partner(s)`,
        );
      }
    }
  }

  /// HARD GATE — drop SUSPENDED / PAUSED / UNVERIFIED partners. The DB is
  /// the source of truth for account standing; a suspended partner can
  /// linger in the Redis pool for up to the sticky TTL (or be put back by
  /// the auto-suspend-on-cancel path that clears their busy flag), so this
  /// is the bulletproof belt that stops a blocked partner from EVER being
  /// offered a job regardless of how they got into the candidate set.
  if (candidates.length > 0) {
    const eligible = await prisma.partner
      .findMany({
        where: {
          id: { in: candidates.map((c) => c.partnerId) },
          isActive: true,
          isVerified: true,
        },
        select: { id: true },
      })
      .catch(() => null);
    /// On a DB read failure, fail OPEN (keep candidates) — a transient
    /// error shouldn't black-hole all dispatch; the DB-side accept guard
    /// still rejects a suspended partner who somehow taps Accept.
    if (eligible) {
      const ok = new Set(eligible.map((p) => p.id));
      const before = candidates.length;
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        if (!ok.has(candidates[i].partnerId)) candidates.splice(i, 1);
      }
      if (before !== candidates.length) {
        logger.info(
          `dispatch wave ${waveNumber} for booking ${bookingId}: dropped ${before - candidates.length} suspended/unverified partner(s)`,
        );
      }
    }
  }

  /// Persist wave/dispatch state on the booking row so the legacy
  /// poll endpoint and admin views can show "broadcasting (3 km, wave 1)".
  await prisma.booking
    .updateMany({
      where: { id: booking.id, status: 'PENDING', partnerId: null },
      data: {
        dispatchStatus: 'broadcasting',
        dispatchStartedAt: dispatchStartAt(booking),
        dispatchExpiresAt: new Date(dispatchStartAt(booking).getTime() + dispatchTotalMsFor(booking)),
        dispatchRadiusKm: radiusKm,
        dispatchWave: waveSpec.wave,
      },
    })
    .catch((err) => logger.warn(`Wave ${waveNumber} state write failed: ${err.message}`));

  if (candidates.length === 0) {
    logger.info(`dispatch wave ${waveNumber} for booking ${bookingId}: no candidates`);
    return;
  }

  /// LAST-MILE status re-check. The status read at the top of this
  /// handler can be tens-to-hundreds of ms stale by now — between it and
  /// here we ran a multi-category GEOSEARCH, liveness MGETs, busy/declined
  /// filters, and a DB write. If the customer CANCELLED (or a partner
  /// accepted, or admin assigned) during that gap, the booking is no
  /// longer offerable — but the top guard already passed, so without this
  /// we'd still blast `dispatch.offer` + FCM pushes for a dead booking.
  /// That's the "I closed the search but the partner kept ringing for ~10
  /// more seconds" bug: the alert came from a wave that started just
  /// before the cancel and pushed just after it. One indexed read closes
  /// the window precisely.
  const liveCheck = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: { status: true, partnerId: true },
  });
  if (!liveCheck || liveCheck.status !== 'PENDING' || liveCheck.partnerId != null) {
    logger.info(
      `dispatch wave ${waveNumber} for booking ${bookingId}: aborted at push ` +
        `(status=${liveCheck?.status ?? 'gone'}, partnerId=${liveCheck?.partnerId ?? 'null'}) — ` +
        `booking left the broadcast window mid-wave`,
    );
    return;
  }

  await registry.recordVisible({
    bookingId: booking.id,
    partnerIds: candidates.map((c) => c.partnerId),
  });

  /// Compute the display fields ONCE before the socket emit so the
  /// payload can carry everything the partner-app needs to render a
  /// rich heads-up notification without a follow-up HTTP fetch. On
  /// Vivo/Oppo/Xiaomi the partner-app can't reliably make an HTTP
  /// call when backgrounded — so we ship `serviceName` + `amount` in
  /// the socket payload itself, matching what the FCM push carries.
  const serviceName = booking.items[0]?.service?.name ?? 'Job request';
  /// Use grandTotal (customer-facing all-in) so the push notification,
  /// the socket dispatch.offer payload, and the in-app job-request
  /// screen all quote the SAME number. BYOP (`offeredPrice`) — partner
  /// set their own price — takes precedence; otherwise fall through to
  /// `grandTotal`, then `total` for old rows that pre-date the
  /// grand-total column being populated.
  const amount = booking.offeredPrice ?? booking.grandTotal ?? booking.total ?? 0;
  /// Best address we can surface without a follow-up DB read — used by
  /// the partner app to render the card instantly (no "Loading address…"
  /// while refreshIncoming is pending). Prefer the stored addressLine
  /// (from an inline or saved address), then the customerAddress join,
  /// then the addressLabel (saved-address nickname). Falls back to ''.
  const address =
    booking.addressLine ||
    booking.customerAddress?.addressLine ||
    booking.addressLabel ||
    '';

  /// Push to connected partners. The gateway's emitter is responsible
  /// for figuring out which candidates have a live socket; the rest
  /// will pick up the offer via partnerIncoming polling.
  if (socketEmitter) {
    for (const c of candidates) {
      socketEmitter('dispatch.offer', c.partnerId, {
        bookingId: booking.id,
        wave: waveSpec.wave,
        radiusKm,
        retry: waveSpec.retry,
        activeForSec: DISPATCH_WINDOW_MS / 1000,
        distanceKm: c.distanceKm,
        serviceName,
        amount,
        address,
      });
    }
  }

  /// Background push notifications. Send to every eligible partner,
  /// not just those without a socket: mobile sockets can remain
  /// "connected" on the server while Android has already suspended the
  /// app, which makes socket-only delivery look successful but produces
  /// no phone alert. The partner app ignores foreground FCM job-request
  /// echoes while active, so the socket path still owns the in-app popup
  /// without duplicate foreground alerts.
  if (candidates.length > 0) {
    void sendJobOfferPushes(
      prisma,
      candidates.map((c) => c.partnerId),
      { bookingId: booking.id, serviceName, amount, dispatchWave: waveSpec.wave, address },
    );
  }

  logger.info(
    `dispatch wave ${waveNumber} for booking ${bookingId}: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'}`,
  );
};

/// Reconciler — runs on a 60s repeatable schedule. Finds PENDING
/// bookings whose dispatch window has clearly closed but for whatever
/// reason never had an expire job fired (Redis was down at create
/// time, the job was evicted, etc.) and re-queues an immediate expire.
///
/// Bounded scan: only looks at the last 24 hours of PENDING rows so
/// this query stays cheap regardless of historical booking volume.
const RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const RECONCILE_GRACE_MS = 10 * 1000;
const handleReconcile = async () => {
  /// Anything created more than (DISPATCH_TOTAL_MS + grace) ago AND
  /// still PENDING + unassigned is orphaned. The grace buffer keeps
  /// fresh-but-still-broadcasting rows out of scope.
  const cutoff = new Date(Date.now() - DISPATCH_TOTAL_MS - RECONCILE_GRACE_MS);
  const lookback = new Date(Date.now() - RECONCILE_LOOKBACK_MS);
  /// Wrapped in withDbRetry — this fires on a timer against a mostly-idle
  /// worker connection, the prime victim of RDS/NAT idle-timeout drops.
  const orphans = await withDbRetry(
    () =>
      prisma.booking.findMany({
        where: {
          status: 'PENDING',
          partnerId: null,
          createdAt: { gte: lookback, lte: cutoff },
        },
        select: { id: true },
        take: 200,
      }),
    { label: 'reconcile.findOrphans' },
  );
  if (orphans.length === 0) return;

  /// Re-enqueue with delay 0 — these are already past their expiry
  /// window so they should fire immediately. BullMQ's idempotent
  /// jobId means re-queueing one we already have is a no-op.
  await Promise.all(orphans.map((b) => queue.enqueueExpire(b.id, 0)));
  logger.info(`reconciler: re-queued expire for ${orphans.length} orphaned PENDING bookings`);
};

/// Reconcile the DB duty MIRROR against the AUTHORITATIVE Redis presence,
/// in BOTH directions. The per-ping change-gate can desync the DB from
/// Redis (e.g. the stale-flip races a reconnecting app, leaving the
/// mirror cache and the DB disagreeing), so this 60s sweep is the
/// safety net that makes the DB always converge to reality:
///
///   • DB says on duty but Redis presence LAPSED  → flip to off_duty
///     (ghost: app killed/crashed without a clean off-duty).
///   • DB says off_duty but Redis presence is LIVE → flip to available
///     (the missed-write case — app reconnected, presence is flowing,
///     but the mirror never re-wrote the DB). Busy partners are left
///     alone: a partner ON A JOB stays 'busy' even though presence is
///     live, so we only promote off_duty → available, never touch busy.
///
/// Both branches realign the duty-mirror cache so the change-gate agrees
/// with the DB afterwards.
const reconcileStaleOnDuty = async () => {
  if (!registry.enabled()) return; // no Redis → presence isn't tracked

  /// Scan the small set of rows in any non-terminal duty interest:
  /// currently-on-duty rows (to catch ghosts) + verified rows that COULD
  /// be online (to catch missed on-writes). We pull verified partners and
  /// check Redis liveness for all of them in one mget.
  const partners = await withDbRetry(
    () =>
      prisma.partner.findMany({
        where: { isVerified: true },
        select: { id: true, onDuty: true, dutyState: true },
        take: 1000,
      }),
    { label: 'reconcile.dutyRows' },
  ).catch(() => []);
  if (partners.length === 0) return;

  const live = await registry.filterOnlinePartnerIds(partners.map((p) => p.id));

  /// STALE-BUSY reconcile. A partner stuck at dutyState='busy' whose job
  /// ended through a path that missed the busy-clear (dispatcher supersede,
  /// deleted booking, admin reassign edge) is INVISIBLE to dispatch and to
  /// the admin "Available" filter — the orphaned `partner:active` flag also
  /// makes upsertOnline silently drop their presence pings. The duty-on
  /// toggle self-heals this (tracking.setDuty), but a partner who never
  /// re-toggles would stay stranded; this sweep is the safety net for them.
  /// A busy row is STALE iff the partner has NO active CONFIRMED/IN_PROGRESS
  /// booking. We only pay for the booking query when there ARE busy rows.
  const busyRows = partners.filter((p) => p.dutyState === 'busy');
  let staleBusyIds = [];
  if (busyRows.length > 0) {
    const busyIds = busyRows.map((p) => p.id);
    const withActive = await withDbRetry(
      () =>
        prisma.booking.findMany({
          where: {
            partnerId: { in: busyIds },
            status: { in: ['CONFIRMED', 'IN_PROGRESS'] },
          },
          select: { partnerId: true },
        }),
      { label: 'reconcile.busyActiveBookings' },
    ).catch(() => []);
    const genuinelyBusy = new Set(withActive.map((b) => b.partnerId));
    staleBusyIds = busyIds.filter((id) => !genuinelyBusy.has(id));
  }

  /// Ghost: marked on duty in DB but no live presence → off_duty.
  const toOff = partners
    .filter((p) => p.onDuty && !live.has(Number(p.id)))
    .map((p) => p.id);
  /// Missed on-write: live presence but DB says off_duty → available.
  /// Also includes STALE-busy rows that ARE still live → back to available.
  const toAvailable = [
    ...partners
      .filter((p) => !p.onDuty && p.dutyState === 'off_duty' && live.has(Number(p.id)))
      .map((p) => p.id),
    ...staleBusyIds.filter((id) => live.has(Number(id))),
  ];
  /// Stale-busy rows with NO live presence → off_duty (and out of the pool).
  const staleBusyToOff = staleBusyIds.filter((id) => !live.has(Number(id)));
  for (const id of [...staleBusyIds]) {
    /// Always drop the orphaned Redis active flag so the next presence
    /// ping (or duty-on) can re-register them without the busy gate.
    await registry.clearActiveJob(id).catch(() => {});
  }
  if (staleBusyToOff.length > 0) toOff.push(...staleBusyToOff);

  if (toOff.length > 0) {
    await withDbRetry(
      () =>
        prisma.partner.updateMany({
          where: { id: { in: toOff } },
          data: { onDuty: false, dutyState: 'off_duty', onDutyChangedAt: new Date() },
        }),
      { label: 'reconcile.flipOff' },
    ).catch((err) => logger.warn(`duty reconcile off-write failed: ${err.message}`));
    await Promise.all(toOff.map((id) => registry.clearDutyMirror(id))).catch(() => {});
  }
  if (toAvailable.length > 0) {
    await withDbRetry(
      () =>
        prisma.partner.updateMany({
          where: { id: { in: toAvailable } },
          data: { onDuty: true, dutyState: 'available', onDutyChangedAt: new Date() },
        }),
      { label: 'reconcile.flipAvailable' },
    ).catch((err) => logger.warn(`duty reconcile on-write failed: ${err.message}`));
    await Promise.all(toAvailable.map((id) => registry.clearDutyMirror(id))).catch(() => {});
  }
  if (toOff.length || toAvailable.length) {
    logger.info(
      `duty reconcile: ${toOff.length} → off_duty, ${toAvailable.length} → available` +
        (staleBusyIds.length ? ` (incl. ${staleBusyIds.length} stale-busy healed)` : ''),
    );
  }
};

/// DURABLE scheduled-dispatch safety net. Runs every SWEEP_EVERY_MS (see
/// queue.ensureDispatchSweepScheduled). Finds scheduled bookings whose
/// broadcast window has ARRIVED but which never actually broadcast, and
/// re-arms them. This is what guarantees a scheduled booking goes out at
/// `scheduledAt - lead` even when the one-shot create-time enqueue was
/// lost or a worker restart left stale jobs behind.
///
/// "Never broadcast" is detected by `dispatchStartedAt IS NULL` — the
/// wave handler stamps that the moment it runs, so a null value means no
/// wave has executed regardless of what `dispatchStatus` claims. We
/// therefore also rescue bookings that an old/premature expire job
/// wrongly flipped to `needs_admin_dispatch` while their real waves
/// hadn't run yet (the exact stale-state symptom seen on worker
/// restarts).
///
/// Scope is deliberately narrow so this is cheap and can't hijack
/// healthy flows:
///   - scheduled only (isInstant=false, offeredPrice=null) — instant +
///     BYOP dispatch at create time, not on a scheduled lead.
///   - still claimable (PENDING, partnerId null)
///   - never broadcast (dispatchStartedAt null)
///   - window is OPEN right now: start <= now < start + DISPATCH_TOTAL_MS
///     so we don't resurrect bookings whose whole window genuinely
///     elapsed (those correctly belong to admin manual dispatch).
const SWEEP_LOOKAHEAD_BUFFER_MS = 5 * 1000;
const handleDispatchSweep = async () => {
  const now = new Date();
  /// DB-side prefilter: scheduled, claimable, not yet broadcast, and
  /// whose dispatch window could plausibly be open now. We compute the
  /// exact per-booking window in JS below (it depends on isInstant /
  /// offeredPrice via dispatchStartAt). The upper bound here is
  /// `scheduledAt <= now + lead + buffer` i.e. start <= now; the lower
  /// bound keeps the scan bounded to bookings whose window hasn't fully
  /// elapsed yet.
  const candidates = await withDbRetry(
    () =>
      prisma.booking.findMany({
        where: {
          status: 'PENDING',
          partnerId: null,
          isInstant: false,
          offeredPrice: null,
          dispatchStartedAt: null,
          dispatchStatus: { in: ['waiting', 'needs_admin_dispatch'] },
          scheduledAt: {
            /// start = scheduledAt - SCHEDULE_DISPATCH_LEAD_MS has passed →
            /// scheduledAt <= now + lead. Add a small buffer so a booking
            /// that becomes due between ticks isn't missed by a hair.
            lte: new Date(now.getTime() + SCHEDULE_DISPATCH_LEAD_MS + SWEEP_LOOKAHEAD_BUFFER_MS),
            /// window not fully elapsed: scheduledAt - lead + TOTAL > now →
            /// scheduledAt > now - TOTAL + lead.
            gt: new Date(now.getTime() - DISPATCH_TOTAL_MS + SCHEDULE_DISPATCH_LEAD_MS),
          },
        },
        select: {
          id: true, isInstant: true, offeredPrice: true,
          scheduledAt: true, createdAt: true, dispatchStatus: true,
        },
        take: 200,
      }),
    { label: 'dispatchSweep.findStranded' },
  );
  if (candidates.length === 0) return;

  let rearmed = 0;
  for (const b of candidates) {
    const start = dispatchStartAt(b).getTime();
    /// Only act while the window is genuinely open. Outside it the
    /// reconciler / expire path owns the booking.
    if (now.getTime() < start || now.getTime() >= start + DISPATCH_TOTAL_MS) continue;

    /// A premature expire flipped it to needs_admin_dispatch before any
    /// wave ran — reset it to `waiting` so handleWave's PENDING guard
    /// will transition it to `broadcasting`. Guarded on the same
    /// (never-broadcast) invariants so we never stomp a real handoff.
    if (b.dispatchStatus === 'needs_admin_dispatch') {
      await prisma.booking
        .updateMany({
          where: {
            id: b.id, status: 'PENDING', partnerId: null,
            dispatchStartedAt: null, dispatchStatus: 'needs_admin_dispatch',
          },
          data: { dispatchStatus: 'waiting' },
        })
        .catch((err) => logger.warn(`sweep: reset ${b.id} failed: ${err.message}`));
      /// Tear down any stale admin_timeout/expire jobs left from the
      /// premature handoff so they don't fire again mid-broadcast.
      await queue.cancelJobsForBooking(b.id).catch(() => {});
    }

    /// (Re)enqueue the full wave + expire schedule. Idempotent jobIds
    /// mean this is a no-op when the jobs already exist, and it heals
    /// the case where they were lost entirely.
    await scheduleAllForBooking({
      id: b.id,
      isInstant: b.isInstant,
      offeredPrice: b.offeredPrice,
      scheduledAt: b.scheduledAt,
      createdAt: b.createdAt,
    }).catch((err) => logger.warn(`sweep: re-arm ${b.id} failed: ${err.message}`));
    rearmed += 1;
  }

  if (rearmed > 0) {
    logger.info(`dispatch sweep: re-armed ${rearmed} stranded scheduled booking(s)`);
  }
};

/// Repeatable job — prune admin + partner notifications past the
/// retention window (7 days). Lazy-required to avoid pulling the
/// notifications module into the dispatcher's import graph at load time.
const handleNotificationCleanup = async () => {
  const { pruneExpired } = require('../notifications/notifications.cleanup');
  return pruneExpired();
};

/// Payment-success handler — runs once per booking after payment is
/// confirmed (either via verifyPayment or the Razorpay webhook).
///
/// Responsibilities:
///   1. If a partner has already been assigned but the booking is still
///      PENDING (edge-case: partner accepted a BYOP, customer paid, but
///      the status transition was skipped), flip it to CONFIRMED.
///   2. Generate a GST invoice PDF and email it to the customer.
///
/// Idempotent — gated on paymentStatus='paid' so re-enqueue after a
/// duplicate webhook is always a no-op.
const handlePaymentSuccess = async ({ bookingId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      partnerId: true,
      bookingRef: true,
      subtotal: true,
      discount: true,
      total: true,
      gstAmount: true,
      platformFee: true,
      grandTotal: true,
      paidAt: true,
      createdAt: true,
      scheduledAt: true,
      addressLine: true,
      addressLabel: true,
      customer: { select: { id: true, name: true, email: true } },
      customerAddress: { select: { addressLine: true } },
      items: {
        select: {
          qty: true,
          basePrice: true,
          service: { select: { name: true } },
        },
      },
    },
  });

  if (!booking) return;
  if (booking.paymentStatus !== 'paid') return;

  /// Safety net for the "paid + cancelled" race: if money settled onto a
  /// booking that's ALREADY cancelled (e.g. an auto-cancel fired while the
  /// payment was in flight), refund it rather than silently keeping the cash.
  /// The socket disconnect / payment-expire guards should prevent this, but
  /// if anything slips through, the customer must not be charged for a dead
  /// booking. Idempotent — refundForBooking no-ops if a refund's already in
  /// progress. We skip invoicing (returns early) since there's nothing to
  /// bill for a cancelled job.
  if (booking.status === 'CANCELLED') {
    logger.warn(
      `payment_success: booking ${bookingId} is CANCELLED but paid — issuing auto-refund`,
    );
    try {
      await razorpayService.refundForBooking({
        bookingId,
        reason: 'Auto-refund: payment settled on an already-cancelled booking',
      });
    } catch (err) {
      logger.error(
        `payment_success: auto-refund for cancelled booking ${bookingId} failed: ${err.message}`,
      );
    }
    return;
  }

  /// Edge-case heal: partner accepted (BYOP) before payment landed, so
  /// the booking has a partnerId but status is still PENDING.
  if (booking.status === 'PENDING' && booking.partnerId != null) {
    const updated = await prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: 'PENDING',
        partnerId: { not: null },
        paymentStatus: 'paid',
      },
      data: { status: 'CONFIRMED' },
    });
    if (updated.count > 0) {
      logger.info(`payment_success: booking ${bookingId} moved PENDING → CONFIRMED (post-payment)`);
    }
  }

  const email = booking.customer?.email;
  if (!email) {
    logger.info(`payment_success: booking ${bookingId} paid — no customer email, skipping invoice`);
    return;
  }

  try {
    const { generateInvoicePdf, buildInvoiceEmailHtml, invoiceNumber } = require('../../lib/invoice');
    const { sendMail } = require('../../lib/email');

    const [pdfBuffer, html] = await Promise.all([
      generateInvoicePdf(booking),
      Promise.resolve(buildInvoiceEmailHtml(booking)),
    ]);

    const invNo = invoiceNumber(booking);
    await sendMail({
      to: email,
      subject: `Your Dhoond Invoice — ${invNo}`,
      html,
      attachments: [
        {
          filename: `dhoond-invoice-${invNo}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    logger.info(`payment_success: invoice ${invNo} emailed → ${email} (booking ${bookingId})`);
  } catch (err) {
    logger.warn(`payment_success: invoice email failed for booking ${bookingId}: ${err.message}`);
    /// Don't rethrow — a failed email must NOT fail the job and trigger
    /// BullMQ retries (that would re-send the same email on every retry).
  }
};

/// BYOP pay-after-accept expiry. Fires 3 min after the partner
/// accepts a booking with `offeredPrice` set. If the customer still
/// hasn't paid, the booking auto-cancels back to CANCELLED (with a
/// distinct dispatchStatus so admin can see why it died) and the
/// partner is unlocked so they can take other jobs.
///
/// Idempotency: gated on (status='CONFIRMED' AND paymentStatus !=
/// 'paid'). A customer who paid in the last 200ms — webhook race —
/// flips the row to paid; updateMany returns count 0 here and we
/// skip the cancel.
const handlePaymentExpire = async ({ bookingId, attempt = 0 }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      partnerId: true,
      offeredPrice: true,
      isInstant: true,
      couponId: true,
      paymentDeadlineAt: true,
      customerId: true,
    },
  });
  if (!booking) return;
  if (booking.paymentStatus === 'paid') {
    /// Already paid, already cancelled, or otherwise out of scope.
    return;
  }
  const isByopTimeout = booking.status === 'CONFIRMED' && booking.offeredPrice != null;
  const isInstantPayTimeout =
    booking.status === 'PENDING' &&
    booking.isInstant &&
    booking.offeredPrice == null &&
    booking.partnerId == null;
  if (!isByopTimeout && !isInstantPayTimeout) return;
  /// Defensive guard against the job firing slightly early — fall
  /// through if we're somehow before the deadline (clock drift,
  /// re-enqueue with smaller delay, etc.).
  if (booking.paymentDeadlineAt && booking.paymentDeadlineAt > new Date()) {
    return;
  }

  /// LAST-CHANCE RECONCILIATION before destroying the row. The payment
  /// may have succeeded at Razorpay without us hearing about it yet —
  /// webhook lag/misconfig, or a UPI payment stranded in 'authorized'
  /// (the "PhonePe debited but the app showed an error" case). Deleting
  /// the booking would also cascade-delete its Payment rows and orphan
  /// the customer's money. Ask Razorpay directly; if it's paid (or
  /// capturable), the reconciler marks the booking paid + triggers
  /// dispatch, and we skip the cancel entirely. Fails open to the
  /// normal expiry path on any Razorpay/API hiccup.
  try {
    const razorpayService = require('../payments/razorpay.service');
    const outcome = await razorpayService.reconcileOrderForBooking(booking.id);
    if (outcome === 'paid') {
      logger.info(
        `payment_expire: booking ${bookingId} reconciled as PAID at Razorpay — cancel skipped`,
      );
      return;
    }
  } catch (err) {
    /// The reconcile check ERRORING is very different from it answering
    /// 'unpaid': it only makes a Razorpay round-trip when a pending payment
    /// row exists — so a throw usually means "there IS a payment attempt
    /// but we couldn't ask Razorpay about it". Destroying the row now could
    /// orphan captured money (booking gone → app shows "Booking not found"
    /// while the customer's account was debited). Leave the row untouched
    /// and re-check up to 3 times, 10 minutes apart; only after that does
    /// the guarded expiry below run (which soft-cancels, never deletes,
    /// when payment rows exist).
    if (attempt < 3) {
      logger.warn(
        `payment_expire: reconciliation for booking ${bookingId} failed (${err.message}) — retry ${attempt + 1}/3 in 10 min`,
      );
      await queue.enqueuePaymentExpireRetry(booking.id, 10 * 60 * 1000, attempt + 1);
      return;
    }
    logger.warn(
      `payment_expire: reconciliation for booking ${bookingId} still failing after ${attempt} retries (${err.message}) — proceeding with guarded expiry`,
    );
  }

  /// If a PARTNER cancelled this booking earlier (it has a
  /// cancellation_penalty adjustment), KEEP it as CANCELLED instead of
  /// hard-deleting — otherwise it vanishes from that partner's Past tab.
  /// Truly-abandoned attempts (never accepted, no partner cancel) are
  /// still deleted to avoid cluttering the data with dead rows.
  const wasPartnerCancelled =
    (await prisma.partnerAdjustment.count({
      where: { bookingId: booking.id, type: 'cancellation_penalty' },
    })) > 0;

  /// Money-trail guard: if ANY payment row exists for this booking, a
  /// checkout was at least started — deleting would cascade-delete those
  /// rows and erase the only server-side link to a possibly-captured
  /// Razorpay payment. Soft-cancel instead so the booking stays visible
  /// (customer's Past tab, admin panel) and support can reconcile/refund
  /// against the provider ids. Only rows with zero payment attempts are
  /// truly abandoned and safe to delete.
  const hasPaymentAttempt =
    (await prisma.payment.count({ where: { bookingId: booking.id } })) > 0;

  const result = await prisma.$transaction(async (tx) => {
    if (booking.couponId != null) {
      await couponsService.refundForBooking({ couponId: booking.couponId, tx });
    }
    if (wasPartnerCancelled || hasPaymentAttempt) {
      return tx.booking.updateMany({
        where: {
          id: booking.id,
          status: booking.status,
          paymentStatus: { not: 'paid' },
        },
        /// noPartnerReason left null so it reads as a real cancellation in
        /// the partner's history (the system-cancel filter keys on this).
        data: { status: 'CANCELLED', noPartnerReason: null },
      });
    }
    return tx.booking.deleteMany({
      where: {
        id: booking.id,
        status: booking.status,
        paymentStatus: { not: 'paid' },
      },
    });
  });
  if (result.count === 0) return;

  await registry.clearBooking(bookingId);
  if (socketEmitter) {
    socketEmitter('booking.payment_expired', `customer:${booking.customerId}`, {
      bookingId: booking.id,
    });
  }
  logger.info(
    `payment_expire: booking ${bookingId} ${
      wasPartnerCancelled || hasPaymentAttempt ? 'soft-cancelled (payment trail kept)' : 'deleted'
    } (unpaid attempt expired)`,
  );
};

/// Wave expiry. After the 7km retry broadcast also passes without
/// an acceptance, we DON'T cancel the booking — instead it transitions
/// to `dispatchStatus: 'needs_admin_dispatch'` while keeping
/// `status: 'PENDING'`. The admin's Manual Dispatch queue picks it up
/// and ops can hand-assign a partner using nearbyPartners + reassign.
///
/// A safety-net `admin_timeout` job is enqueued at the same time —
/// if ops doesn't action the booking inside `ADMIN_DISPATCH_GRACE_MS`,
/// `handleAdminTimeout` flips it to CANCELLED with all the same
/// refund/cleanup the old behaviour did.
const handleExpire = async ({ bookingId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true, status: true, partnerId: true, customerId: true,
      offeredPrice: true, paymentStatus: true,
    },
  });
  if (!booking) return;
  if (booking.status !== 'PENDING' || booking.partnerId != null) {
    /// Already accepted / cancelled — clean up Redis and bail.
    await registry.clearBooking(bookingId);
    return;
  }

  /// BYOP abandon shortcut. "Book at your price" broadcasts BEFORE
  /// payment, so an unpaid BYOP booking that reached the end of the
  /// broadcast window with no partner is an ABANDONED price request —
  /// the customer never committed money and (typically) has left. There
  /// is no point routing it to admin manual dispatch for a 2-hour grace:
  /// even if an admin assigned a partner, there's no paying customer on
  /// the other end. Cancel it now and stop broadcasting. (Fixed-price
  /// bookings are pre-paid, so they still go to the admin queue below.)
  const isUnpaidByop =
    booking.offeredPrice != null && booking.paymentStatus !== 'paid';
  if (isUnpaidByop) {
    const cancelled = await prisma.booking.updateMany({
      where: { id: booking.id, status: 'PENDING', partnerId: null },
      data: {
        status: 'CANCELLED',
        dispatchStatus: 'no_partner_found',
        dispatchExpiresAt: null,
        noPartnerReason:
          'Book-at-your-price request expired — no partner accepted within the broadcast window and payment was never made.',
      },
    });
    if (cancelled.count === 0) return;

    /// Tear down the broadcast everywhere, same as the admin-route path.
    const audience = await registry.listPartnersForBooking(bookingId).catch(() => []);
    await registry.clearBooking(bookingId);
    if (audience.length > 0) {
      if (socketEmitter) {
        for (const pid of audience) {
          socketEmitter('dispatch.claimed', pid, { bookingId, partnerId: null, reason: 'expired' });
        }
      }
      void clearJobOfferPush(prisma, audience, bookingId);
    }
    /// Let the customer app know the request ended (so any lingering
    /// "searching" UI closes out to a clean state).
    if (socketEmitter) {
      socketEmitter('booking.expired', `customer:${booking.customerId}`, { bookingId: booking.id });
    }
    logger.info(`dispatch expire: BYOP booking ${bookingId} cancelled (unpaid, no partner accepted)`);
    return;
  }

  /// Atomic transition — `updateMany` with status='PENDING' guard so a
  /// late race against partnerAccept can't overwrite a CONFIRMED row.
  ///
  /// PAID bookings have NO auto-cancel deadline: the customer's money is
  /// committed, so the row stays in the Manual Dispatch queue until an
  /// admin assigns a partner or explicitly cancels (which refunds).
  /// Only unpaid rows keep the auto-cleanup grace window.
  const isPaid = booking.paymentStatus === 'paid';
  const result = await prisma.booking.updateMany({
    where: { id: booking.id, status: 'PENDING', partnerId: null },
    data: {
      dispatchStatus: 'needs_admin_dispatch',
      dispatchRadiusKm: FINAL_DISPATCH_WAVE.radiusKm,
      dispatchWave: FINAL_DISPATCH_WAVE.wave,
      dispatchExpiresAt: isPaid ? null : new Date(Date.now() + ADMIN_DISPATCH_GRACE_MS),
      noPartnerReason:
        'No partner accepted within 3km, 5km, or 7km broadcast and retry windows — awaiting admin dispatch.',
    },
  });
  if (result.count === 0) return;

  /// Snapshot who was offered this booking BEFORE clearBooking wipes the
  /// visibleTo set — we use it to clear their FCM "New job" notification
  /// (the window closed, so the offer is dead; don't leave it lingering
  /// in backgrounded partners' notification bars).
  const offerAudience = await registry.listPartnersForBooking(bookingId).catch(() => []);

  /// Clear the broadcast-time Redis state (visibleTo set, claim locks)
  /// — the booking is no longer being broadcast to partners. The
  /// partner-app's "active offer" UI on every connected partner will
  /// disappear, leaving a clean slate for admin's manual dispatch.
  await registry.clearBooking(bookingId);

  /// Dismiss the offer everywhere: socket (connected) + FCM (backgrounded).
  if (offerAudience.length > 0) {
    if (socketEmitter) {
      for (const pid of offerAudience) {
        socketEmitter('dispatch.claimed', pid, { bookingId, partnerId: null, reason: 'expired' });
      }
    }
    void clearJobOfferPush(prisma, offerAudience, bookingId);
  }

  /// Schedule the safety-net auto-cancel — UNPAID bookings only. Paid
  /// bookings must never be auto-cancelled: they wait in the Manual
  /// Dispatch queue until an admin acts, however long that takes.
  if (!isPaid) {
    await queue.enqueueAdminTimeout(bookingId, ADMIN_DISPATCH_GRACE_MS);
  }

  if (socketEmitter) {
    /// Tell the customer the broadcast finished without a match — they
    /// see "We're finding you a partner" instead of "No partner found".
    /// Cart-screen UI keeps the booking alive.
    socketEmitter('booking.needs_admin_dispatch', `customer:${booking.customerId}`, {
      bookingId: booking.id,
    });
    /// Notify the admin namespace so a connected ops user sees a toast
    /// + sidebar badge increment without waiting for a page refresh.
    socketEmitter('booking.needs_admin_dispatch', 'admins', {
      bookingId: booking.id,
    });
  }

  /// Persistent bell-icon entry for every admin — survives socket
  /// disconnects and shows up on next login. Mirrors the realtime
  /// socket emit above but doesn't depend on it.
  try {
    const adminNotifs = require('../notifications/admin-notifications.service');
    void adminNotifs.notifyAllAdmins({
      type: adminNotifs.TYPES.BOOKING_DISPATCH_NEEDED,
      title: `Manual dispatch needed for #${booking.id}`,
      body: isPaid
        ? 'PAID booking — no partner accepted in the broadcast windows. It will WAIT in Manual Dispatch until you assign a partner or cancel (with refund).'
        : 'No partner accepted in the 3 km / 5 km / 7 km broadcast and retry windows. Assign one before the 2-hour grace elapses.',
      href: '/bookings/manual-dispatch',
      bookingId: booking.id,
    });
  } catch { /* never block dispatch on a notif insert */ }

  logger.info(
    `dispatch expire: booking ${bookingId} routed to admin manual dispatch (grace ${ADMIN_DISPATCH_GRACE_MS / 60000}m)`,
  );
};

/// Safety net for the manual-dispatch handoff. Fires
/// `ADMIN_DISPATCH_GRACE_MS` after `handleExpire` routes a booking to
/// admin. If admin still hasn't dispatched it, we cancel + refund — same
/// flow the old expire used to run, just delayed by the grace window.
///
/// Gated on (status='PENDING' AND partnerId=null AND dispatchStatus=
/// 'needs_admin_dispatch'). If admin assigned a partner in the meantime,
/// the dispatchStatus has moved on (or partnerId is set) and the
/// updateMany returns 0 — safe no-op.
const handleAdminTimeout = async ({ bookingId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      partnerId: true,
      dispatchStatus: true,
      paymentStatus: true,
      couponId: true,
      customerId: true,
    },
  });
  if (!booking) return;
  if (
    booking.status !== 'PENDING' ||
    booking.partnerId != null ||
    booking.dispatchStatus !== 'needs_admin_dispatch'
  ) {
    return;
  }

  /// PAID bookings are NEVER auto-cancelled — they wait in the Manual
  /// Dispatch queue until an admin assigns a partner or cancels (which
  /// refunds). handleExpire no longer enqueues this job for paid rows;
  /// this guard covers timeout jobs enqueued BEFORE that policy change
  /// and any reconciler re-fires.
  if (booking.paymentStatus === 'paid') {
    logger.info(
      `admin_timeout: booking ${bookingId} is PAID — left in manual dispatch queue (no auto-cancel)`,
    );
    return;
  }

  /// A booking a PARTNER cancelled is kept (as CANCELLED) even when unpaid,
  /// so it survives in that partner's Past tab. Only truly-abandoned unpaid
  /// bookings (never accepted by anyone) are hard-deleted.
  const wasPartnerCancelled =
    (await prisma.partnerAdjustment.count({
      where: { bookingId: booking.id, type: 'cancellation_penalty' },
    })) > 0;

  let didCancel = false;
  let didDelete = false;
  await prisma.$transaction(async (tx) => {
    if (booking.paymentStatus === 'paid' || wasPartnerCancelled) {
      const result = await tx.booking.updateMany({
        where: {
          id: booking.id,
          status: 'PENDING',
          partnerId: null,
          dispatchStatus: 'needs_admin_dispatch',
        },
        data: {
          status: 'CANCELLED',
          dispatchStatus: 'no_partner_found',
          /// Keep noPartnerReason null for partner-cancelled rows so the
          /// partner-history filter treats them as real cancellations;
          /// the unpaid-abandoned-but-kept case (paid) keeps the reason.
          noPartnerReason: wasPartnerCancelled
            ? null
            : 'No partner found within broadcast and retry windows; admin grace period elapsed without manual dispatch.',
        },
      });
      didCancel = result.count > 0;
    } else {
      if (booking.couponId != null) {
        await couponsService.refundForBooking({ couponId: booking.couponId, tx });
      }
      const result = await tx.booking.deleteMany({
        where: {
          id: booking.id,
          status: 'PENDING',
          partnerId: null,
          dispatchStatus: 'needs_admin_dispatch',
          paymentStatus: { not: 'paid' },
        },
      });
      didDelete = result.count > 0;
    }
  });
  if (!didCancel && !didDelete) return;

  if (didCancel) {
    try {
      await razorpayService.refundForBooking({
        bookingId,
        reason: 'No partner found within broadcast + admin grace window',
      });
    } catch (err) {
      logger.warn(`Refund kick failed for booking ${bookingId}: ${err.message}`);
    }

    if (socketEmitter) {
      socketEmitter('booking.expired', `customer:${booking.customerId}`, {
        bookingId: booking.id,
      });
    }
  }

  if (didDelete) {
    await registry.clearBooking(bookingId);
    if (socketEmitter) {
      socketEmitter('booking.expired', `customer:${booking.customerId}`, {
        bookingId: booking.id,
      });
    }
  }

  logger.info(
    `admin_timeout: booking ${bookingId} ${didDelete ? 'deleted' : 'cancelled'} (admin grace elapsed)`,
  );
};

/// Boot the worker. Called once from server.js. Returns null if the
/// queue isn't enabled (REDIS_URL unset) — caller checks before
/// asking for graceful shutdown.
const start = () => {
  if (!queue.enabled() || worker) return worker;

  const connection = queue.buildWorkerConnection();
  if (!connection) return null;

  worker = new Worker(
    'dispatch',
    async (job) => {
      switch (job.name) {
        case 'wave':
          return handleWave(job.data);
        case 'expire':
          return handleExpire(job.data);
        case 'admin_timeout':
          return handleAdminTimeout(job.data);
        case 'payment_expire':
          return handlePaymentExpire(job.data);
        case 'payment_success':
          return handlePaymentSuccess(job.data);
        case 'reconcile':
          /// Run both reconcilers on the 60s tick: orphaned bookings +
          /// stale onDuty mirror rows. Independent, so settle both even
          /// if one throws.
          await Promise.allSettled([handleReconcile(), reconcileStaleOnDuty()]);
          return;
        case 'dispatch_sweep':
          return handleDispatchSweep();
        case 'notification_cleanup':
          return handleNotificationCleanup();
        default:
          logger.warn(`dispatch worker: unknown job name "${job.name}"`);
      }
    },
    {
      connection,
      /// Concurrency 8 means up to 8 wave/expire jobs run in parallel.
      /// Each is mostly Redis + a few Postgres reads, so this is easily
      /// handled by a single Node process at our target scale.
      concurrency: 8,
    },
  );

  worker.on('failed', (job, err) => {
    logger.warn(
      `dispatch job ${job?.name ?? '?'}:${job?.id ?? '?'} failed: ${err.message}`,
    );
  });

  /// Install the recurring reconcile schedule. Idempotent — if the
  /// schedule already exists in Redis, BullMQ leaves it in place.
  queue.ensureReconcilerScheduled().catch((err) => {
    logger.warn(`Failed to schedule reconciler: ${err.message}`);
  });

  /// Install the recurring dispatch sweep — the durable safety net that
  /// re-arms scheduled bookings whose broadcast window arrived but never
  /// fired (lost create-time enqueue, restart-stale jobs, premature
  /// admin handoff). Run one pass immediately so anything already
  /// stranded is rescued on boot instead of waiting for the first tick.
  queue.ensureDispatchSweepScheduled().catch((err) => {
    logger.warn(`Failed to schedule dispatch sweep: ${err.message}`);
  });
  handleDispatchSweep().catch((err) => {
    logger.warn(`Initial dispatch sweep failed: ${err.message}`);
  });

  /// Install the recurring notification-cleanup schedule, and run one
  /// pass immediately so anything already past the retention window is
  /// pruned on boot instead of waiting for the first interval.
  queue.ensureNotificationCleanupScheduled().catch((err) => {
    logger.warn(`Failed to schedule notification cleanup: ${err.message}`);
  });
  handleNotificationCleanup().catch((err) => {
    logger.warn(`Initial notification cleanup failed: ${err.message}`);
  });

  logger.info('Dispatch worker started (push mode enabled)');
  return worker;
};

const stop = async () => {
  if (worker) {
    await worker.close();
    worker = null;
  }
  await queue.close();
};

module.exports = {
  DISPATCH_WAVES,
  DISPATCH_TOTAL_MS,
  SCHEDULE_DISPATCH_LEAD_MS,
  ADMIN_DISPATCH_GRACE_MS,
  dispatchStartAt,
  scheduleAllForBooking,
  cancelAllForBooking,
  schedulePaymentExpire,
  broadcastClaimed,
  emitToPartner,
  emitToCustomer,
  setSocketEmitter,
  isPartnerConnected,
  start,
  stop,
};
