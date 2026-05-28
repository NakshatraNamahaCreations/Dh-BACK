const { Queue } = require('bullmq');
const Redis = require('ioredis');
const env = require('../../config/env');
const logger = require('../../config/logger');

/// BullMQ wants its OWN ioredis connection per queue instance with
/// `maxRetriesPerRequest: null` (the library docs are blunt about this).
/// We can't reuse the cache layer's client because that one has
/// `maxRetriesPerRequest: 1` for cache-fail-fast semantics.
///
/// Returns null if REDIS_URL is unset — every consumer here checks
/// `enabled()` and falls back to legacy polling-based dispatch when
/// the queue isn't available, so dev without Redis still works.
let queueConnection = null;
let dispatchQueue = null;

const enabled = () => Boolean(env.REDIS_URL);

if (env.REDIS_URL) {
  queueConnection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  queueConnection.on('error', (err) => {
    logger.warn(`BullMQ connection: ${err.message}`);
  });

  /// Single queue handles both wave fan-out and expiry — keeping them
  /// in one queue means one worker process / one set of metrics, and
  /// the job `name` discriminator (`wave` vs `expire`) is enough to
  /// route to the right handler.
  dispatchQueue = new Queue('dispatch', {
    connection: queueConnection,
    defaultJobOptions: {
      /// Don't keep dead jobs around forever — they pile up fast at scale.
      /// 500 completed / 1000 failed gives enough trace for debugging
      /// without ballooning Redis memory. Tune in env if needed.
      removeOnComplete: { count: 500, age: 24 * 3600 },
      removeOnFail: { count: 1000, age: 7 * 24 * 3600 },
      attempts: 2,
      backoff: { type: 'exponential', delay: 1000 },
    },
  });
}

/// BullMQ rejects custom job IDs that contain `:` because it uses
/// that character as its own internal namespace separator (for the
/// repeat-job descriptor, schedule key, etc.). Using `:` in our IDs
/// causes "Custom Id cannot contain :" failures, most visibly on the
/// recurring reconciler. We use `__` instead — same idempotency
/// semantics, zero risk of clashing with BullMQ internals.
const enqueueWave = async (bookingId, waveNumber, delayMs) => {
  if (!dispatchQueue) return null;
  return dispatchQueue.add(
    'wave',
    { bookingId, wave: waveNumber },
    {
      delay: delayMs,
      /// Idempotency — if we crash and replay, we don't want two
      /// "wave 2" jobs for the same booking. The jobId is composed
      /// of bookingId + wave so re-queueing is a no-op.
      jobId: `wave__${bookingId}__${waveNumber}`,
    },
  );
};

const enqueueExpire = async (bookingId, delayMs) => {
  if (!dispatchQueue) return null;
  return dispatchQueue.add(
    'expire',
    { bookingId },
    {
      delay: delayMs,
      jobId: `expire__${bookingId}`,
    },
  );
};

/// Admin-timeout job. Fires `ADMIN_DISPATCH_GRACE_MS` after a booking
/// enters `needs_admin_dispatch` (i.e. all radius attempts and retries
/// expired with no acceptance) and auto-cancels the booking if admin still
/// hasn't dispatched it manually. Without this safety net, an
/// unattended needs-admin booking would sit in the queue forever.
const enqueueAdminTimeout = async (bookingId, delayMs) => {
  if (!dispatchQueue) return null;
  return dispatchQueue.add(
    'admin_timeout',
    { bookingId },
    {
      delay: delayMs,
      jobId: `admin_timeout__${bookingId}`,
    },
  );
};

/// BYOP pay-after-accept timer. Fires once at +delayMs from accept
/// and auto-cancels the booking if the customer still hasn't paid.
/// Idempotent jobId — re-accept (which shouldn't happen, but defends
/// against retries) just refreshes the existing schedule.
const enqueuePaymentExpire = async (bookingId, delayMs) => {
  if (!dispatchQueue) return null;
  return dispatchQueue.add(
    'payment_expire',
    { bookingId },
    {
      delay: delayMs,
      jobId: `payment_expire__${bookingId}`,
    },
  );
};

/// Recurring reconciler — installs a repeatable BullMQ job that fires
/// every RECONCILE_EVERY_MS and looks for orphaned PENDING bookings.
/// Idempotent: BullMQ dedupes repeatable jobs by their key, so calling
/// this from both the API and the standalone worker process is safe.
const RECONCILE_EVERY_MS = 60 * 1000;
const ensureReconcilerScheduled = async () => {
  if (!dispatchQueue) return;

  /// One-shot cleanup of broken historical schedules. We previously
  /// used `reconcile:repeat` as the jobId, which BullMQ rejected
  /// (custom IDs can't contain `:`). The bad schedule is still in
  /// Redis after the fix, so it keeps firing alongside the new one
  /// and spamming the log with "Custom Id cannot contain :"
  /// warnings. Walk the repeatable list and remove anything whose
  /// name is `reconcile` — there should only ever be one and
  /// ensureReconcilerScheduled() will add it back fresh below.
  try {
    const existing = await dispatchQueue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === 'reconcile') {
        await dispatchQueue.removeRepeatableByKey(job.key).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn(`Failed to clean up old reconciler schedules: ${err.message}`);
  }

  await dispatchQueue.add(
    'reconcile',
    {},
    {
      repeat: { every: RECONCILE_EVERY_MS },
      /// Stable key so the repeatable job isn't duplicated across
      /// process restarts. (BullMQ uses this to identify the schedule
      /// internally.)
      jobId: 'reconcile__repeat',
      /// Reconciler is idempotent and self-correcting; keep one
      /// completed and a few failed records for visibility, no more.
      removeOnComplete: { count: 1 },
      removeOnFail: { count: 10 },
    },
  );
};

/// Recurring notification cleanup — installs a repeatable job that
/// prunes admin + partner notifications older than the retention window
/// (see notifications.cleanup). Same idempotent pattern as the
/// reconciler: BullMQ dedupes by the stable jobId, so calling this from
/// both the API and the standalone worker is safe. Every 6h is plenty —
/// a notification is removed within 6h of crossing the 7-day mark.
const NOTIFICATION_CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;
const ensureNotificationCleanupScheduled = async () => {
  if (!dispatchQueue) return;
  try {
    const existing = await dispatchQueue.getRepeatableJobs();
    for (const job of existing) {
      if (job.name === 'notification_cleanup') {
        await dispatchQueue.removeRepeatableByKey(job.key).catch(() => {});
      }
    }
  } catch (err) {
    logger.warn(`Failed to clean up old notification-cleanup schedules: ${err.message}`);
  }

  await dispatchQueue.add(
    'notification_cleanup',
    {},
    {
      repeat: { every: NOTIFICATION_CLEANUP_EVERY_MS },
      jobId: 'notification_cleanup__repeat',
      removeOnComplete: { count: 1 },
      removeOnFail: { count: 10 },
    },
  );
};

/// Cancel any pending wave/expiry jobs for a booking — used when a
/// partner accepts (we don't need future waves to fire) or when admin
/// cancels manually. Best-effort: if the job already moved to active
/// or completed, BullMQ's remove() is a no-op for those states which
/// is exactly what we want.
const cancelJobsForBooking = async (bookingId) => {
  if (!dispatchQueue) return;
  const ids = [
    ...Array.from({ length: 6 }, (_, index) => `wave__${bookingId}__${index + 1}`),
    `expire__${bookingId}`,
    `admin_timeout__${bookingId}`,
  ];
  await Promise.all(
    ids.map((id) =>
      dispatchQueue.remove(id).catch(() => {
        /// Job already ran or never existed — both are fine.
      }),
    ),
  );
};

const close = async () => {
  if (dispatchQueue) await dispatchQueue.close();
  if (queueConnection) await queueConnection.quit().catch(() => {});
};

module.exports = {
  enabled,
  /// Exposed for the worker module — same connection options BullMQ
  /// requires, kept in one place so we don't drift.
  buildWorkerConnection: () => {
    if (!env.REDIS_URL) return null;
    const conn = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    conn.on('error', (err) => logger.warn(`BullMQ worker connection: ${err.message}`));
    return conn;
  },
  dispatchQueue,
  enqueueWave,
  enqueueExpire,
  enqueueAdminTimeout,
  enqueuePaymentExpire,
  ensureReconcilerScheduled,
  ensureNotificationCleanupScheduled,
  cancelJobsForBooking,
  close,
};
