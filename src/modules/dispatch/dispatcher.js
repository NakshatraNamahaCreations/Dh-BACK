const { Worker } = require('bullmq');
const couponsService = require('../coupons/coupons.service');
const razorpayService = require('../payments/razorpay.service');
const prisma = require('../../config/prisma');
const logger = require('../../config/logger');
const queue = require('./queue');
const registry = require('./registry');
const { sendJobOfferPushes } = require('../notifications/push.service');

/**
 * BullMQ-driven dispatch — Phase 2 of the dispatcher rewrite.
 *
 * Replaces the lazy `expireBroadcasts()` + per-poll haversine model
 * with a push-style flow:
 *
 *   1. `bookings.create` enqueues four delayed jobs:
 *        wave 1 → fires at +0   s   (3 km)
 *        wave 2 → fires at +30  s   (5 km)
 *        wave 3 → fires at +60  s   (7 km)
 *        expire → fires at +90  s   (no-partner-found if still PENDING)
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
 *        - drops partners who already have an active job (Redis-side
 *          via the `partner:active:{id}` flag set on accept)
 *        - SADDs survivors to `booking:visibleTo:{bookingId}`
 *        - emits a `dispatch.offer` event to each candidate's socket
 *          (when connected) and writes to the booking's wave columns
 *          for the polling-fallback partner-app
 *
 *   3. The expire handler:
 *        - re-reads the booking
 *        - if still PENDING + unassigned, transitions to CANCELLED
 *          with `dispatchStatus: 'no_partner_found'` and refunds the
 *          coupon if one was redeemed
 *        - clears the Redis booking keys
 *
 * Idempotency: the queue uses `wave:{bookingId}:{n}` and
 * `expire:{bookingId}` job ids, so a process restart that replays
 * pending jobs won't double-fire. The DB transition uses
 * `updateMany({ where: { status: 'PENDING', partnerId: null } })`
 * so a wave that fires after a partner already accepted is a no-op.
 */

/// Dispatch cadence for the customer-facing "within 10 min" promise.
///
/// We fan out across the three rings *fast* (0s / 15s / 30s) so a
/// partner in the closest ring gets a real shot first, then the 5km
/// and 7km rings open up before any meaningful wait. After the third
/// wave fires, the 7km offer stays live for the rest of the 10-min
/// window — any partner who comes online in that radius can still
/// accept up until expiry.
///
///   Wave 1 (0:00)   — 3km, partner alert
///   Wave 2 (0:15)   — 5km, partner alert
///   Wave 3 (0:30)   — 7km, partner alert
///   Expiry (10:00)  — booking flips to `needs_admin_dispatch`,
///                     ops takes over from here.
const DISPATCH_WAVES = [
  { wave: 1, radiusKm: 3, offsetMs: 0 },
  { wave: 2, radiusKm: 5, offsetMs: 15 * 1000 },
  { wave: 3, radiusKm: 7, offsetMs: 30 * 1000 },
];
const DISPATCH_TOTAL_MS = 10 * 60 * 1000;
const SCHEDULE_DISPATCH_LEAD_MS = 30 * 60 * 1000;
/// When all three waves elapse without acceptance, the booking is
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

/// Schedule all four jobs for a booking. Called from bookings.create
/// right after the row is inserted. Negative delays (i.e. dispatch
/// should already have started — happens for scheduled bookings whose
/// dispatch lead-time has already passed by the time of insert) are
/// clamped to 0 so the wave runs immediately.
const scheduleAllForBooking = async (booking) => {
  if (!queue.enabled()) return;
  const start = dispatchStartAt(booking).getTime();
  const now = Date.now();

  for (const w of DISPATCH_WAVES) {
    const delay = Math.max(0, start + w.offsetMs - now);
    await queue.enqueueWave(booking.id, w.wave, delay);
  }
  const expireDelay = Math.max(0, start + DISPATCH_TOTAL_MS - now);
  await queue.enqueueExpire(booking.id, expireDelay);
};

/// Cancel scheduled jobs for a booking — used when a partner accepts
/// (no need for waves 2 + 3 or the expirer to fire) or when admin
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
  if (!socketEmitter || !audience || audience.length === 0) return;
  for (const pid of audience) {
    if (pid === payload.partnerId) continue;
    socketEmitter('dispatch.claimed', pid, payload);
  }
};

/// One wave: find candidates, mark them visible, push to sockets.
const handleWave = async ({ bookingId, wave: waveNumber }) => {
  const waveSpec = DISPATCH_WAVES.find((w) => w.wave === waveNumber);
  if (!waveSpec) return;

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
      `anchor=(${booking.lat}, ${booking.lng}) radius=${waveSpec.radiusKm}km ` +
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
      radiusKm: waveSpec.radiusKm,
      limit: 50,
    });
    logger.info(
      `  category ${cat}: pool=${poolSize} online, ` +
        `${rows.length} within ${waveSpec.radiusKm}km` +
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

  /// Persist wave/dispatch state on the booking row so the legacy
  /// poll endpoint and admin views can show "broadcasting (3 km, wave 1)".
  await prisma.booking
    .updateMany({
      where: { id: booking.id, status: 'PENDING', partnerId: null },
      data: {
        dispatchStatus: 'broadcasting',
        dispatchStartedAt: dispatchStartAt(booking),
        dispatchExpiresAt: new Date(dispatchStartAt(booking).getTime() + DISPATCH_TOTAL_MS),
        dispatchRadiusKm: waveSpec.radiusKm,
        dispatchWave: waveSpec.wave,
      },
    })
    .catch((err) => logger.warn(`Wave ${waveNumber} state write failed: ${err.message}`));

  if (candidates.length === 0) {
    logger.info(`dispatch wave ${waveNumber} for booking ${bookingId}: no candidates`);
    return;
  }

  await registry.recordVisible({
    bookingId: booking.id,
    partnerIds: candidates.map((c) => c.partnerId),
  });

  /// Push to connected partners. The gateway's emitter is responsible
  /// for figuring out which candidates have a live socket; the rest
  /// will pick up the offer via partnerIncoming polling.
  if (socketEmitter) {
    for (const c of candidates) {
      socketEmitter('dispatch.offer', c.partnerId, {
        bookingId: booking.id,
        wave: waveSpec.wave,
        radiusKm: waveSpec.radiusKm,
        distanceKm: c.distanceKm,
      });
    }
  }

  /// Background push notifications — reach partners whose app is
  /// closed or minimised. Fires after the socket emit so the
  /// connected partners get the in-app alert first; disconnected
  /// partners get the device notification instead.
  const serviceName = booking.items[0]?.service?.name ?? 'Job request';
  const amount = booking.offeredPrice ?? booking.total ?? 0;
  void sendJobOfferPushes(
    prisma,
    candidates.map((c) => c.partnerId),
    { bookingId: booking.id, serviceName, amount },
  );

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
  const orphans = await prisma.booking.findMany({
    where: {
      status: 'PENDING',
      partnerId: null,
      createdAt: { gte: lookback, lte: cutoff },
    },
    select: { id: true },
    take: 200,
  });
  if (orphans.length === 0) return;

  /// Re-enqueue with delay 0 — these are already past their expiry
  /// window so they should fire immediately. BullMQ's idempotent
  /// jobId means re-queueing one we already have is a no-op.
  await Promise.all(orphans.map((b) => queue.enqueueExpire(b.id, 0)));
  logger.info(`reconciler: re-queued expire for ${orphans.length} orphaned PENDING bookings`);
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
const handlePaymentExpire = async ({ bookingId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      partnerId: true,
      offeredPrice: true,
      paymentDeadlineAt: true,
      customerId: true,
    },
  });
  if (!booking) return;
  if (booking.status !== 'CONFIRMED' || booking.paymentStatus === 'paid') {
    /// Already paid, already cancelled, or otherwise out of scope.
    return;
  }
  /// Defensive guard against the job firing slightly early — fall
  /// through if we're somehow before the deadline (clock drift,
  /// re-enqueue with smaller delay, etc.).
  if (booking.paymentDeadlineAt && booking.paymentDeadlineAt > new Date()) {
    return;
  }

  const result = await prisma.booking.updateMany({
    where: {
      id: booking.id,
      status: 'CONFIRMED',
      paymentStatus: { not: 'paid' },
    },
    data: {
      status: 'CANCELLED',
      dispatchStatus: 'payment_timeout',
      noPartnerReason: 'Customer did not pay within the 3-minute window after partner accepted.',
      partnerId: null,
    },
  });
  if (result.count === 0) return;

  if (socketEmitter) {
    socketEmitter('booking.payment_expired', `customer:${booking.customerId}`, {
      bookingId: booking.id,
    });
  }
  logger.info(`payment_expire: booking ${bookingId} cancelled (3-min pay window elapsed)`);
};

/// Wave expiry. After the 7km / wave-3 broadcast also passes without
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
    select: { id: true, status: true, partnerId: true, customerId: true },
  });
  if (!booking) return;
  if (booking.status !== 'PENDING' || booking.partnerId != null) {
    /// Already accepted / cancelled — clean up Redis and bail.
    await registry.clearBooking(bookingId);
    return;
  }

  /// Atomic transition — `updateMany` with status='PENDING' guard so a
  /// late race against partnerAccept can't overwrite a CONFIRMED row.
  const result = await prisma.booking.updateMany({
    where: { id: booking.id, status: 'PENDING', partnerId: null },
    data: {
      dispatchStatus: 'needs_admin_dispatch',
      dispatchRadiusKm: 7,
      dispatchWave: 3,
      dispatchExpiresAt: new Date(Date.now() + ADMIN_DISPATCH_GRACE_MS),
      noPartnerReason:
        'No partner accepted within 3km, 5km, or 7km broadcast windows — awaiting admin dispatch.',
    },
  });
  if (result.count === 0) return;

  /// Clear the broadcast-time Redis state (visibleTo set, claim locks)
  /// — the booking is no longer being broadcast to partners. The
  /// partner-app's "active offer" UI on every connected partner will
  /// disappear, leaving a clean slate for admin's manual dispatch.
  await registry.clearBooking(bookingId);

  /// Schedule the safety-net auto-cancel. If admin assigns a partner
  /// (or manually cancels) before this fires, cancelAllForBooking
  /// removes the job during the partnerAccept / adminCancel path.
  await queue.enqueueAdminTimeout(bookingId, ADMIN_DISPATCH_GRACE_MS);

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
      body: 'No partner accepted in the 3 km / 5 km / 7 km broadcast windows. Assign one before the 2-hour grace elapses.',
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

  let didCancel = false;
  await prisma.$transaction(async (tx) => {
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
        noPartnerReason:
          'No partner found within broadcast window; admin grace period elapsed without manual dispatch.',
      },
    });
    if (result.count > 0) {
      didCancel = true;
      if (booking.couponId != null) {
        await couponsService.refundForBooking({ couponId: booking.couponId, tx });
      }
    }
  });

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

  logger.info(`admin_timeout: booking ${bookingId} cancelled (admin grace elapsed)`);
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
        case 'reconcile':
          return handleReconcile();
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
  setSocketEmitter,
  start,
  stop,
};
