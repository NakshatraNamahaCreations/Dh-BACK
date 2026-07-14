/**
 * Razorpay payment integration service.
 *
 * Lifecycle:
 *   1. Customer taps "Pay now" → backend `createOrder()` calls Razorpay's
 *      Orders API to mint an order id (`order_xxx`). We persist it as a
 *      new row in the `payments` table (status="pending") and update the
 *      Booking rollup to paymentStatus="pending".
 *   2. Customer-app opens Razorpay Checkout with the order id; user enters
 *      UPI / card / netbanking details; Razorpay returns
 *      { razorpay_payment_id, razorpay_order_id, razorpay_signature }.
 *   3. Customer-app POSTs the triple to `verifyPayment()` which
 *      cryptographically validates the signature using the key secret
 *      (HMAC-SHA256 over `${order_id}|${payment_id}`). On match we mark
 *      the Payment row paid, save providerPaymentId/Signature + paidAt,
 *      and update the Booking rollup.
 *   4. Razorpay also fires a webhook to `/payments/razorpay/webhook` for
 *      out-of-band confirmation (e.g. user closes app mid-payment but
 *      payment still completes server-side). The webhook is verified the
 *      same way using the WEBHOOK_SECRET (different from the API secret)
 *      and idempotently moves the Payment + Booking rollup to paid if
 *      they aren't already.
 *
 * Why Payment is a separate table:
 *   - One Booking can have several payment attempts (failed first try +
 *     successful retry). Storing only the latest on Booking would lose
 *     the audit trail.
 *   - The Booking's paymentStatus column is a denormalised cache of the
 *     latest Payment.status so list endpoints don't have to join — same
 *     pattern as `couponDiscount`. The `syncBookingRollup` helper is
 *     responsible for keeping the cache fresh.
 *
 * Env vars (set in .env, never commit):
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   RAZORPAY_WEBHOOK_SECRET
 */
const crypto = require('crypto');
const Razorpay = require('razorpay');
const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const dispatchQueue = require('../dispatch/queue');
const couponsService = require('../coupons/coupons.service');

const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

/// Lazy singleton — instantiated only on first use so the rest of the
/// backend (e.g. local dev without keys) can still boot.
let _client = null;
const client = () => {
  if (_client) return _client;
  if (!KEY_ID || !KEY_SECRET) {
    throw ApiError.internal(
      'Razorpay keys missing — set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in .env',
    );
  }
  _client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return _client;
};

/// Customer-app needs the publishable key to open Checkout. Never returns
/// the secret. Falls back to undefined when keys are missing so the
/// customer app can detect dev/test mode.
exports.publicKey = () => KEY_ID ?? null;

/// Post-payment dispatch trigger for instant fixed-price bookings.
///
/// Booking-creation deliberately SKIPS the dispatcher enqueue for
/// `isInstant && offeredPrice == null` (pay-upfront instant) so we
/// don't broadcast a phantom offer while waiting on the customer's
/// payment. This helper fires the 3km → 5km → 7km wave schedule once
/// the payment lands.
///
/// Idempotent — the dispatch queue uses `wave:{bookingId}:{n}` job
/// ids so re-enqueue after a webhook + verify race is a no-op. Safe
/// to call multiple times for the same booking.
///
/// Lazy require for `dispatcher` to avoid the
/// razorpay → dispatcher → razorpay (refunds) cycle.
const triggerDispatchIfNeeded = async (bookingId) => {
  if (!dispatchQueue.enabled()) return;
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: {
      id: true,
      status: true,
      partnerId: true,
      isInstant: true,
      offeredPrice: true,
      createdAt: true,
      scheduledAt: true,
      dispatchStatus: true,
    },
  });
  if (!booking) return;
  /// Only fire for instant fixed-price bookings that are still in the
  /// initial "waiting" pre-broadcast state. BYOP bookings dispatched
  /// at create-time; scheduled non-instant bookings have their own
  /// timeline. A booking that's already been accepted, cancelled, or
  /// is mid-broadcast doesn't need (and shouldn't get) a fresh
  /// schedule of wave jobs.
  if (!(booking.isInstant && booking.offeredPrice == null)) return;
  if (booking.status !== 'PENDING' || booking.partnerId != null) return;
  if (booking.dispatchStatus !== 'waiting') return;

  try {
    const dispatcher = require('../dispatch/dispatcher');
    await dispatcher.scheduleAllForBooking(booking);
    logger.info(
      `dispatch: enqueued waves for paid instant booking ${booking.id} (post-payment trigger)`,
    );
  } catch (err) {
    logger.warn(
      `Post-payment dispatch enqueue failed for booking ${booking.id}: ${err.message}`,
    );
  }
};

const deleteUnpaidInstantBookingAttempt = async (tx, bookingId) => {
  const booking = await tx.booking.findUnique({
    where: { id: Number(bookingId) },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      isInstant: true,
      offeredPrice: true,
      partnerId: true,
      couponId: true,
    },
  });
  if (
    !booking ||
    booking.status !== 'PENDING' ||
    booking.paymentStatus === 'paid' ||
    !booking.isInstant ||
    booking.offeredPrice != null ||
    booking.partnerId != null
  ) {
    return false;
  }

  const paid = await tx.payment.findFirst({
    where: { bookingId: booking.id, status: 'paid' },
    select: { id: true },
  });
  if (paid) return false;

  if (booking.couponId != null) {
    await couponsService.refundForBooking({ couponId: booking.couponId, tx });
  }

  const deleted = await tx.booking.deleteMany({
    where: {
      id: booking.id,
      status: 'PENDING',
      paymentStatus: { not: 'paid' },
      isInstant: true,
      offeredPrice: null,
      partnerId: null,
    },
  });
  return deleted.count > 0;
};

/// Pull the latest Payment status into Booking.paymentStatus /
/// paymentMethod / paidAt so list reads don't need to join. Always uses
/// the most recent payment row — failed attempts followed by a paid
/// retry roll up as paid; multiple pendings keep status pending.
const syncBookingRollup = async (tx, bookingId) => {
  /// "Most relevant" = paid/refunded if any (terminal states win), else
  /// the latest pending/failed by createdAt. This avoids a paid retry
  /// being shadowed by a later failed attempt on the same booking
  /// (which shouldn't happen with our flow, but is the safe ordering
  /// regardless).
  /// Only "booking" purpose rows participate — add-on charges (purpose
  /// "addons") have their own lifecycle on the BookingAddOn rows and
  /// must never flip the main bill's paymentStatus.
  const paid = await tx.payment.findFirst({
    where: { bookingId, purpose: 'booking', status: { in: ['paid', 'refunded'] } },
    orderBy: { createdAt: 'desc' },
  });
  const latest =
    paid ??
    (await tx.payment.findFirst({
      where: { bookingId, purpose: 'booking' },
      orderBy: { createdAt: 'desc' },
    }));

  await tx.booking.update({
    where: { id: bookingId },
    data: {
      paymentStatus: latest?.status ?? 'unpaid',
      paymentMethod: latest?.method ?? null,
      paidAt: latest?.paidAt ?? null,
      /// Clear the BYOP pay-after-accept deadline once payment lands
      /// — the deadline is meaningful only while we're waiting on the
      /// customer. Leaving it set isn't strictly wrong (the auto-cancel
      /// worker checks paymentStatus first), but blanking it here keeps
      /// the row honest for admin reads and avoids confusing UI states.
      ...(latest?.status === 'paid' ? { paymentDeadlineAt: null } : {}),
    },
  });
};

/// Build a Razorpay order for the given Booking. Amount is read from the
/// booking itself (offeredPrice when set, else total). Reuses an existing
/// pending Payment row if there is one — Razorpay orders are pinned to a
/// single Checkout attempt, but the customer can re-open Checkout with
/// the same order id if they closed the sheet without paying.
exports.createOrder = async ({ bookingId, customerId }) => {
  /// Coerce both sides — `req.user.sub` from the JWT comes in as a
  /// string (RFC 7519 forces `sub` to a string when serialised) while
  /// `booking.customerId` is a Prisma Int. A strict `!==` between them
  /// would 403 every legitimate request.
  const customerIdNum = Number(customerId);
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: {
      id: true,
      customerId: true,
      total: true,
      grandTotal: true,
      offeredPrice: true,
      paymentStatus: true,
      status: true,
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.customerId !== customerIdNum) throw ApiError.forbidden('Not your booking');
  if (booking.status === 'CANCELLED') throw ApiError.badRequest('Booking is cancelled');
  if (booking.paymentStatus === 'paid') {
    throw ApiError.badRequest('This booking is already paid');
  }

  /// Charge `grandTotal` — the customer-facing amount that includes
  /// 18% GST and 2% platform fee on top of the partner-facing total.
  /// Fall back to legacy `offeredPrice ?? total` for pre-breakdown
  /// rows where grandTotal wasn't snapshotted at create time.
  const payable = booking.grandTotal && booking.grandTotal > 0
    ? booking.grandTotal
    : (booking.offeredPrice ?? booking.total);
  const amountPaise = payable * 100;

  /// Reuse the most recent pending Razorpay payment if any — the
  /// customer probably backed out of Checkout and is retrying. Mints
  /// a fresh order otherwise. BUT: if the booking's current amount
  /// no longer matches the reusable row's amount (cart edited, BYOP
  /// price bumped, coupon applied/removed), the old order is stale
  /// — Razorpay will accept the payment for the OLD amount and then
  /// reject our verify when amounts don't reconcile, surfacing as
  /// the user-facing "Uh! oh! Something went wrong" Razorpay sheet.
  /// Detect the mismatch, fail the old row, mint a fresh one.
  const reusable = await prisma.payment.findFirst({
    where: {
      bookingId: booking.id,
      provider: 'razorpay',
      status: 'pending',
      purpose: 'booking',
    },
    orderBy: { createdAt: 'desc' },
  });
  const currentAmount = payable;
  if (reusable?.providerOrderId) {
    if (reusable.amount === currentAmount) {
      /// Belt-and-braces: ask Razorpay if the order is still openable.
      /// Our DB row says "pending" but Razorpay independently expires
      /// orders, marks them `attempted` (customer started + bailed),
      /// or returns 404 if the order was never minted in this account
      /// (key-swap between dev/prod). Handing such an id to the
      /// checkout SDK triggers the "Uh! oh! Something went wrong"
      /// branded error sheet. Round-trip cost is one HTTPS to
      /// Razorpay (~150-300ms); worth it to avoid the support load.
      try {
        const remote = await client().orders.fetch(reusable.providerOrderId);
        const reusableStatus = remote?.status; // 'created' | 'attempted' | 'paid'
        if (reusableStatus === 'created') {
          return {
            orderId: reusable.providerOrderId,
            amount: amountPaise,
            currency: 'INR',
            keyId: KEY_ID,
          };
        }
        logger.warn(
          `[razorpay] reusable order ${reusable.providerOrderId} not openable (status=${reusableStatus}); minting fresh`,
        );
        await prisma.payment.update({
          where: { id: reusable.id },
          data: {
            status: 'failed',
            failureReason: `Razorpay order no longer openable (status=${reusableStatus}); retired`,
          },
        });
      } catch (fetchErr) {
        /// Razorpay 404 / network blip / key mismatch — the safe move
        /// is to retire and mint fresh. If we returned the id anyway,
        /// the customer's checkout would fail with the same opaque
        /// error we're trying to eliminate.
        logger.warn(
          `[razorpay] could not fetch reusable order ${reusable.providerOrderId} (${fetchErr.message}); minting fresh`,
        );
        await prisma.payment.update({
          where: { id: reusable.id },
          data: {
            status: 'failed',
            failureReason: `Razorpay fetch failed (${fetchErr.message}); retired`,
          },
        });
      }
    } else {
      /// Amount drift — retire the stale row and fall through to a
      /// fresh order below. We don't await any razorpay-side cancel
      /// (their API accepts duplicate orders fine; the unused one
      /// just expires on its own clock).
      await prisma.payment.update({
        where: { id: reusable.id },
        data: {
          status: 'failed',
          failureReason: `Order amount changed (${reusable.amount} → ${currentAmount}); retired`,
        },
      });
    }
  }

  const order = await client().orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `booking_${booking.id}`,
    notes: { bookingId: String(booking.id), customerId: String(customerIdNum) },
  });
  logger.info(
    `[razorpay] minted fresh order ${order.id} for booking ${booking.id} (amount=${amountPaise} paise)`,
  );

  await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        bookingId: booking.id,
        amount: payable,
        currency: 'INR',
        status: 'pending',
        method: 'razorpay',
        provider: 'razorpay',
        providerOrderId: order.id,
      },
    });
    await syncBookingRollup(tx, booking.id);
  });

  return {
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: KEY_ID,
  };
};

/// Verify the signature returned by Razorpay Checkout and mark the
/// matching Payment row paid. Throws on signature mismatch — never trust
/// a "success" callback from the client without this server-side check.
exports.verifyPayment = async ({
  bookingId,
  customerId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw ApiError.badRequest('Missing Razorpay fields');
  }
  if (!KEY_SECRET) throw ApiError.internal('RAZORPAY_KEY_SECRET not set');

  const customerIdNum = Number(customerId);
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: { id: true, customerId: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.customerId !== customerIdNum) throw ApiError.forbidden('Not your booking');

  /// Find the Payment row this Checkout result belongs to. Order ids are
  /// unique per booking — this is also the authoritative check that the
  /// customer isn't replaying someone else's order id.
  const payment = await prisma.payment.findFirst({
    where: { bookingId: booking.id, providerOrderId: razorpayOrderId },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) throw ApiError.badRequest('Order id not found for this booking');

  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expected !== razorpaySignature) {
    /// Log enough context that we can debug "Uh! oh!" reports — the
    /// expected vs received signature is the truth that tells us
    /// whether the customer's app was sending a fresh payload or a
    /// stale one. We log only the LAST 8 characters of each so the
    /// log isn't a copy of the secret payload.
    logger.warn(
      `[razorpay] signature mismatch for booking ${booking.id}: ` +
        `order=${razorpayOrderId} payment=${razorpayPaymentId} ` +
        `expected=…${expected.slice(-8)} received=…${(razorpaySignature || '').slice(-8)}`,
    );
    /// Mark the Payment row failed so the customer-app can surface a
    /// retry CTA, then refresh the Booking rollup so partner/admin
    /// views flip to "Payment failed".
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'failed', failureReason: 'Signature verification failed' },
      });
      const deleted = await deleteUnpaidInstantBookingAttempt(tx, booking.id);
      if (!deleted) await syncBookingRollup(tx, booking.id);
    });
    throw ApiError.badRequest('Signature verification failed');
  }

  /// Idempotent: if a webhook already marked this paid we don't need to
  /// re-write it, but we still refresh the rollup just in case the
  /// previous transition skipped (older code path).
  if (payment.status === 'paid') {
    await prisma.$transaction(async (tx) => syncBookingRollup(tx, booking.id));
    return prisma.booking.findUnique({ where: { id: booking.id } });
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'paid',
        method: 'razorpay',
        providerPaymentId: razorpayPaymentId,
        providerSignature: razorpaySignature,
        paidAt: new Date(),
      },
    });
    await syncBookingRollup(tx, booking.id);
    return tx.booking.findUnique({ where: { id: booking.id } });
  });

  /// Kick off the partner broadcast for instant pay-upfront bookings.
  /// Fire-and-forget — money is already in, and the dispatcher's
  /// reconciler will pick up any orphaned PENDING rows on the next
  /// 60s tick. Awaiting this could let a transient prisma / Redis
  /// hiccup turn into a verify-response failure, which the customer
  /// experiences as Razorpay's "Uh! oh! Something went wrong" sheet.
  triggerDispatchIfNeeded(booking.id).catch((err) => {
    logger.warn(
      `Post-payment dispatch trigger failed for booking ${booking.id}: ${err.message}`,
    );
  });

  /// Enqueue invoice-generation + email delivery. 3 s delay (set in
  /// enqueuePaymentSuccess) lets this transaction commit before the
  /// worker reads the booking row. Idempotent jobId deduplicates with
  /// any concurrent webhook that also fires enqueuePaymentSuccess.
  dispatchQueue.enqueuePaymentSuccess(booking.id).catch((err) => {
    logger.warn(`payment_success enqueue failed for booking ${booking.id}: ${err.message}`);
  });

  return result;
};

/// Mark the add-ons covered by a captured "addons" Payment as paid.
/// Shared by the verify path and the webhook backup path — idempotent
/// (updateMany on still-unpaid rows only).
const applyAddOnCapture = async (tx, payment, providerPaymentId, signature = null) => {
  await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: 'paid',
      method: 'razorpay',
      providerPaymentId,
      ...(signature ? { providerSignature: signature } : {}),
      paidAt: new Date(),
    },
  });
  await tx.bookingAddOn.updateMany({
    where: { id: { in: payment.addOnIds ?? [] }, status: { not: 'paid' } },
    data: { status: 'paid', paidAt: new Date() },
  });
};

/// Build a Razorpay order covering the booking's UNPAID add-ons.
/// Separate from `createOrder` on purpose: the amount is the flat sum of
/// unpaid add-on lines (no GST/fee re-split), the Payment row is tagged
/// purpose="addons" with an id snapshot, and the main bill's rollup is
/// never touched. Any older pending add-on order is retired first —
/// simpler and safer than reuse, since partners can add/remove lines
/// between attempts.
exports.createAddOnOrder = async ({ bookingId, customerId }) => {
  const customerIdNum = Number(customerId);
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: { id: true, customerId: true, status: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.customerId !== customerIdNum) throw ApiError.forbidden('Not your booking');
  if (booking.status === 'CANCELLED') throw ApiError.badRequest('Booking is cancelled');

  const due = await prisma.bookingAddOn.findMany({
    where: { bookingId: booking.id, status: { not: 'paid' } },
    select: { id: true, price: true, qty: true },
  });
  if (!due.length) throw ApiError.badRequest('No unpaid add-ons on this booking');
  const payable = due.reduce((s, a) => s + a.price * a.qty, 0);
  const amountPaise = payable * 100;

  /// Retire any older pending add-on order — the line-set or amount may
  /// have changed since it was minted, and a stale Razorpay order id
  /// surfaces as the opaque "Uh! oh!" checkout error.
  await prisma.payment.updateMany({
    where: { bookingId: booking.id, purpose: 'addons', status: 'pending' },
    data: { status: 'failed', failureReason: 'Superseded by a fresh add-on order' },
  });

  const order = await client().orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `addons_${booking.id}_${Date.now() % 1e8}`,
    notes: {
      kind: 'booking_addons',
      bookingId: String(booking.id),
      customerId: String(customerIdNum),
    },
  });
  logger.info(
    `[razorpay] minted add-on order ${order.id} for booking ${booking.id} (amount=${amountPaise} paise, lines=${due.length})`,
  );

  await prisma.payment.create({
    data: {
      bookingId: booking.id,
      amount: payable,
      currency: 'INR',
      status: 'pending',
      method: 'razorpay',
      provider: 'razorpay',
      providerOrderId: order.id,
      purpose: 'addons',
      addOnIds: due.map((a) => a.id),
    },
  });

  return { orderId: order.id, amount: amountPaise, currency: 'INR', keyId: KEY_ID };
};

/// Verify an add-on Checkout result and settle the covered add-on lines.
/// Mirrors `verifyPayment`'s HMAC check but never touches the booking
/// rollup, dispatch, or invoicing — add-ons are a side-bill.
exports.verifyAddOnPayment = async ({
  bookingId,
  customerId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw ApiError.badRequest('Missing Razorpay fields');
  }
  if (!KEY_SECRET) throw ApiError.internal('RAZORPAY_KEY_SECRET not set');

  const customerIdNum = Number(customerId);
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: { id: true, customerId: true },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.customerId !== customerIdNum) throw ApiError.forbidden('Not your booking');

  const payment = await prisma.payment.findFirst({
    where: { bookingId: booking.id, providerOrderId: razorpayOrderId, purpose: 'addons' },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) throw ApiError.badRequest('Order id not found for this booking');

  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  if (expected !== razorpaySignature) {
    logger.warn(
      `[razorpay] add-on signature mismatch for booking ${booking.id}: order=${razorpayOrderId}`,
    );
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'failed', failureReason: 'Signature verification failed' },
    });
    throw ApiError.badRequest('Signature verification failed');
  }

  if (payment.status !== 'paid') {
    await prisma.$transaction(async (tx) => {
      await applyAddOnCapture(tx, payment, razorpayPaymentId, razorpaySignature);
    });
  }
  return { bookingId: booking.id, addOnPaymentStatus: 'paid' };
};

/// LAST-CHANCE reconciliation before a booking is auto-cancelled or
/// deleted for non-payment. Asks Razorpay directly whether the order
/// was actually paid — covering webhook lag/misconfig and the UPI
/// "debited but stuck in authorized" case. If a captured (or
/// capturable) payment exists, walk the same paid-transition the
/// webhook would have done and report 'paid' so the caller SKIPS the
/// cancel. Returns 'unpaid' when there's genuinely no money.
exports.reconcileOrderForBooking = async (bookingId) => {
  const payment = await prisma.payment.findFirst({
    where: {
      bookingId: Number(bookingId),
      provider: 'razorpay',
      purpose: 'booking',
      status: 'pending',
      providerOrderId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) return 'unpaid';

  const result = await client().orders.fetchPayments(payment.providerOrderId);
  const attempts = result?.items ?? [];

  let winning = attempts.find((p) => p.status === 'captured');
  if (!winning) {
    const authorized = attempts.find((p) => p.status === 'authorized');
    if (authorized) {
      /// Money is debited but uncaptured — capture it now instead of
      /// letting the booking die and Razorpay auto-refund days later.
      await client().payments.capture(
        authorized.id,
        authorized.amount,
        authorized.currency ?? 'INR',
      );
      winning = authorized;
      logger.info(
        `[razorpay] reconcile: captured authorized payment ${authorized.id} for booking ${bookingId}`,
      );
    }
  }
  if (!winning) return 'unpaid';

  /// Same transition as the payment.captured webhook branch.
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: 'paid',
        method: 'razorpay',
        providerPaymentId: winning.id,
        paidAt: new Date(),
      },
    });
    await syncBookingRollup(tx, payment.bookingId);
  });
  await triggerDispatchIfNeeded(payment.bookingId);
  dispatchQueue.enqueuePaymentSuccess(payment.bookingId).catch((err) => {
    logger.warn(
      `payment_success enqueue (reconcile) failed for booking ${payment.bookingId}: ${err.message}`,
    );
  });
  logger.info(`[razorpay] reconcile: booking ${bookingId} recovered as PAID`);
  return 'paid';
};

/// Issue a refund for a paid booking. Called from cancelOwn /
/// adminCancel / no-partner expiry — anywhere a paid Booking gets
/// flipped to CANCELLED. Idempotent: if the latest Payment is already
/// in refund_pending or refunded, returns null without re-calling
/// Razorpay (avoids double-refunds on retried cancel actions).
///
/// Flow:
///   1. Find the most recent paid Payment row for the booking.
///   2. Call Razorpay's refund API (creates a refund_xxx in their
///      system; money moves on a 5-7 day cycle).
///   3. Mark our Payment row `refund_pending` with refundAmount set.
///      Webhook (`refund.processed`) flips it to `refunded` once the
///      money actually leaves Razorpay's float.
///
/// `tx` is optional — when supplied, the Payment update + rollup run
/// inside the caller's transaction so the cancel + refund kick are
/// atomic. We DON'T wrap the Razorpay API call in the transaction
/// (Razorpay calls aren't transactional), which means there's a small
/// window where the refund was created at Razorpay but our DB write
/// failed. That's acceptable because the next webhook will reconcile
/// our row, and the refund itself is the source of truth.
///
/// `refundAmount` (whole rupees) issues a PARTIAL refund — used by the
/// customer cancel flow to keep the cancellation fee (refund = paid −
/// fee). Omitted/null = full refund of the captured amount (the legacy
/// behaviour, still used by adminCancel / no-partner expiry). The
/// amount is clamped to the captured total; a non-positive amount
/// means "fee ate the whole payment" and we skip the Razorpay call
/// entirely (returning null) rather than asking Razorpay to refund ₹0.
exports.refundForBooking = async ({ bookingId, reason, refundAmount = null } = {}, tx = null) => {
  if (!KEY_SECRET) {
    throw ApiError.internal('RAZORPAY_KEY_SECRET not set — cannot issue refunds');
  }
  const db = tx ?? prisma;

  /// Latest paid Payment row. We don't refund partial / pending /
  /// failed rows — those don't have a captured Razorpay payment to
  /// refund against. Razorpay's API rejects refunds without a
  /// providerPaymentId anyway.
  const payment = await db.payment.findFirst({
    where: {
      bookingId: Number(bookingId),
      status: 'paid',
      provider: 'razorpay',
      providerPaymentId: { not: null },
      /// Cancel-refunds target the ORIGINAL bill. Add-on charges
      /// (purpose "addons") are separate captures with their own money
      /// trail — never silently swap one in as "the" booking payment.
      purpose: 'booking',
    },
    orderBy: { paidAt: 'desc' },
  });
  if (!payment) {
    /// Either unpaid (so nothing to refund — silent no-op) or already
    /// in refund flow (idempotency guard).
    return null;
  }

  /// Resolve how much to actually refund. `refundAmount == null` keeps
  /// the historical full-refund behaviour; an explicit value is clamped
  /// into [0, captured]. A non-positive resolved amount (100% fee) means
  /// there's nothing to send back — return without touching Razorpay or
  /// flipping the Payment into refund_pending, so the row stays `paid`
  /// (the platform kept the whole capture as the cancellation fee).
  const resolvedRefund =
    refundAmount == null
      ? payment.amount
      : Math.min(payment.amount, Math.max(0, Math.round(refundAmount)));
  if (resolvedRefund <= 0) {
    return { paymentId: payment.id, razorpayRefundId: null, amount: 0, status: 'no_refund' };
  }

  /// Razorpay refund API expects amount in paise.
  const amountPaise = resolvedRefund * 100;
  const refundResp = await client().payments.refund(payment.providerPaymentId, {
    amount: amountPaise,
    speed: 'normal',
    notes: {
      bookingId: String(bookingId),
      reason: reason ? String(reason).slice(0, 200) : 'Booking cancelled',
    },
  });

  /// Persist the in-flight refund. We use status `refund_pending` to
  /// distinguish "we asked Razorpay" from "Razorpay confirmed the
  /// money moved" — the webhook walks it to `refunded` in step 2.
  const updateRefundState = async (txn) => {
    await txn.payment.update({
      where: { id: payment.id },
      data: {
        status: 'refund_pending',
        refundAmount: resolvedRefund,
        failureReason: null,
        /// Stash the Razorpay refund id in providerPaymentId-adjacent
        /// space — re-using `providerSignature` here would be confusing,
        /// so we tag it onto failureReason in a structured way only if
        /// the schema gets a `providerRefundId` column later. For now
        /// the refund is identifiable via the webhook payload joining
        /// on providerPaymentId + bookingId.
      },
    });
    await syncBookingRollup(txn, payment.bookingId);
  };

  if (tx) {
    await updateRefundState(tx);
  } else {
    await prisma.$transaction(updateRefundState);
  }

  return {
    paymentId: payment.id,
    razorpayRefundId: refundResp?.id ?? null,
    amount: resolvedRefund,
    status: 'refund_pending',
  };
};

/// Partner onboarding-fee order. Distinct from booking payments because:
///   - The amount lives on Partner.onboardingFeeAmount (set by admin),
///     not on a Booking row.
///   - There's no `payments` table row — the audit columns live directly
///     on Partner (onboardingFeeOrderId / onboardingFeePaymentId).
///   - One partner mints at most one paid order in their lifetime;
///     a re-attempt reuses the existing pending order to avoid orphaning
///     Razorpay orders we never bill.
exports.createOnboardingOrder = async ({ partnerId }) => {
  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      callVerified: true,
      onboardingFeeAmount: true,
      onboardingFeeOrderId: true,
      paymentStatus: true,
      isVerified: true,
    },
  });
  if (!partner) throw ApiError.notFound('Partner not found');
  if (!partner.callVerified) {
    throw ApiError.forbidden('Call verification must be completed before payment.');
  }
  if (partner.onboardingFeeAmount == null || partner.onboardingFeeAmount <= 0) {
    throw ApiError.forbidden('Onboarding fee has not been set by admin yet.');
  }
  if (partner.paymentStatus === 'paid') {
    throw ApiError.badRequest('Onboarding fee is already paid.');
  }

  const amountPaise = partner.onboardingFeeAmount * 100;

  /// Reuse the pending order if the partner re-opens the screen — a
  /// fresh order each time would orphan the old one at Razorpay and
  /// confuse the audit trail. We only mint a new order if there isn't
  /// one yet OR the cached id doesn't match the current amount (admin
  /// edited the fee between attempts).
  if (partner.onboardingFeeOrderId) {
    try {
      const existing = await client().orders.fetch(partner.onboardingFeeOrderId);
      if (existing && existing.amount === amountPaise && existing.status !== 'paid') {
        return {
          orderId: existing.id,
          amount: amountPaise,
          currency: 'INR',
          keyId: KEY_ID,
          partner: {
            name: partner.name,
            email: partner.email,
            phone: partner.phone,
          },
        };
      }
    } catch {
      /// Razorpay 404 or transient error — fall through to mint a new
      /// order. The DB column will overwrite below.
    }
  }

  const order = await client().orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: `partner_onboarding_${partner.id}`,
    notes: {
      kind: 'partner_onboarding',
      partnerId: String(partner.id),
    },
  });

  await prisma.partner.update({
    where: { id: partner.id },
    data: { onboardingFeeOrderId: order.id },
  });

  return {
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    keyId: KEY_ID,
    partner: {
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
    },
  };
};

/// Verify the signed payload Razorpay Checkout returns to the partner
/// app, then flip the Partner row to `paid`. We delegate the actual
/// state change to `auth.service.partnerPaymentDone` so the
/// docs/call/fee guards already enforced there stay the single source
/// of truth — this function's job is purely to prove the payment was
/// genuine before that runs.
exports.verifyOnboardingPayment = async ({
  partnerId,
  razorpayOrderId,
  razorpayPaymentId,
  razorpaySignature,
}) => {
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw ApiError.badRequest('Missing Razorpay fields');
  }
  if (!KEY_SECRET) throw ApiError.internal('RAZORPAY_KEY_SECRET not set');

  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: {
      id: true,
      onboardingFeeOrderId: true,
      paymentStatus: true,
    },
  });
  if (!partner) throw ApiError.notFound('Partner not found');
  if (partner.onboardingFeeOrderId !== razorpayOrderId) {
    /// Replay / tampering guard — the order id in the signed payload
    /// must match the one we minted for this partner. Refuse if not.
    throw ApiError.badRequest('Order id does not match this partner');
  }

  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expected !== razorpaySignature) {
    throw ApiError.badRequest('Signature verification failed');
  }

  /// Persist the Razorpay payment id for audit; the actual
  /// paymentStatus flip happens in `partnerPaymentDone` (called from
  /// the auth controller after this returns).
  await prisma.partner.update({
    where: { id: partner.id },
    data: { onboardingFeePaymentId: razorpayPaymentId },
  });

  return { ok: true };
};

/// Webhook handler — Razorpay POSTs payment events here independently of
/// the customer app. We rely on this as a backup so a payment that
/// completed after the user backgrounded the app still flips the
/// booking to paid.
///
/// IMPORTANT: the webhook route MUST receive the raw request body (not
/// JSON-parsed) so we can hash exactly what Razorpay signed. The route
/// wires `express.raw()` for this path only — see payments.routes.js.
exports.handleWebhook = async ({ rawBody, signature }) => {
  if (!WEBHOOK_SECRET) {
    throw ApiError.internal('RAZORPAY_WEBHOOK_SECRET not set');
  }
  const bodyBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : (typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : null);
  if (!bodyBuffer) {
    throw ApiError.badRequest('Webhook raw body unavailable');
  }
  const expected = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(bodyBuffer)
    .digest('hex');
  if (expected !== signature) {
    throw ApiError.badRequest('Invalid webhook signature');
  }

  const payload = JSON.parse(bodyBuffer.toString('utf8'));
  const event = payload?.event;
  if (!event) return { ok: true, ignored: true };

  /// Refund events carry a `refund` entity with a parent
  /// `payment_id`. We branch here because the entity layout differs
  /// from regular payment events — same webhook URL, different shape.
  if (event.startsWith('refund.')) {
    return handleRefundWebhook(event, payload);
  }

  const entity = payload?.payload?.payment?.entity;
  if (!entity) return { ok: true, ignored: true };

  /// Partner onboarding fee is a separate flow — orders are minted
  /// with `notes.kind = 'partner_onboarding'` and `notes.partnerId`.
  /// Branch out so the booking-payment logic below doesn't reject
  /// these as "no bookingId in notes".
  if (entity.notes?.kind === 'partner_onboarding' && entity.notes?.partnerId) {
    return handlePartnerOnboardingWebhook(event, entity);
  }

  /// Add-on side-bill — settle the covered BookingAddOn rows without
  /// touching the main booking rollup / dispatch / invoicing. Backup
  /// for the explicit verify call (app closed mid-checkout etc.).
  if (entity.notes?.kind === 'booking_addons') {
    return handleAddOnWebhook(event, entity);
  }

  /// Try to recover the bookingId from the order's notes (we set this
  /// in createOrder). Fall back to the receipt format `booking_{id}`.
  const orderId = entity.order_id;
  const noteBookingId = entity.notes?.bookingId;
  const bookingId = noteBookingId ? Number(noteBookingId) : null;
  if (!bookingId || !orderId) return { ok: true, ignored: true };

  const payment = await prisma.payment.findFirst({
    where: { bookingId, providerOrderId: orderId },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) return { ok: true, ignored: true };

  /// UPI-intent safety net: the customer's bank debits at AUTHORIZE
  /// time, but the order only completes at CAPTURE. If dashboard
  /// auto-capture is off/slow, payments strand in 'authorized' (the
  /// customer sees "Uh! oh!" + money gone) until Razorpay auto-refunds.
  /// Capture it ourselves the moment we hear about it — idempotent;
  /// if auto-capture races us, Razorpay returns already-captured and
  /// the payment.captured webhook below settles the rest.
  if (event === 'payment.authorized' && payment.status !== 'paid') {
    try {
      await client().payments.capture(entity.id, entity.amount, entity.currency ?? 'INR');
      logger.info(
        `[razorpay] server-side captured authorized payment ${entity.id} for booking ${bookingId}`,
      );
    } catch (err) {
      logger.warn(
        `[razorpay] capture of authorized payment ${entity.id} failed (${err.error?.description ?? err.message}) — waiting on captured/failed webhook`,
      );
    }
    return { ok: true };
  }

  /// Map Razorpay events to Payment.status. Idempotent — we never
  /// overwrite a paid row with a later failed event for the same order.
  if (event === 'payment.captured' && payment.status !== 'paid') {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'paid',
          method: 'razorpay',
          providerPaymentId: entity.id,
          paidAt: new Date(),
        },
      });
      await syncBookingRollup(tx, bookingId);
    });
    /// LATE CAPTURE on a booking that's already CANCELLED (e.g. the
    /// UPI payment stranded in 'authorized', the pay-deadline worker
    /// cancelled the booking, and the capture landed minutes later).
    /// The customer's money is with us for a dead booking — refund it
    /// immediately instead of waiting for a support ticket.
    const bookingNow = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });
    if (bookingNow?.status === 'CANCELLED') {
      logger.warn(
        `[razorpay] capture landed on CANCELLED booking ${bookingId} — auto-refunding`,
      );
      try {
        await exports.refundForBooking({
          bookingId,
          reason: 'Payment captured after the booking was auto-cancelled',
        });
      } catch (err) {
        logger.warn(
          `[razorpay] auto-refund for cancelled booking ${bookingId} failed: ${err.message} — admin retry needed`,
        );
      }
      return { ok: true };
    }

    /// Backup trigger — fires when verify never ran (e.g. user closed
    /// the app mid-Razorpay-flow but the payment still captured).
    /// Idempotent with the verify-path trigger via the queue's
    /// `wave:{bookingId}:{n}` job ids.
    await triggerDispatchIfNeeded(bookingId);

    /// Idempotent with the verify-path enqueue — same jobId means only
    /// one invoice is generated and emailed even when both paths fire.
    dispatchQueue.enqueuePaymentSuccess(bookingId).catch((err) => {
      logger.warn(`payment_success enqueue (webhook) failed for booking ${bookingId}: ${err.message}`);
    });
  } else if (event === 'payment.failed' && payment.status !== 'paid') {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          failureReason: entity.error_description ?? 'Payment failed',
        },
      });
      const deleted = await deleteUnpaidInstantBookingAttempt(tx, bookingId);
      if (!deleted) await syncBookingRollup(tx, bookingId);
    });
  }
  return { ok: true };
};

/// Refund webhook branch. Razorpay fires three events of interest:
///   refund.created    — we initiated, queued at Razorpay (no-op here;
///                       our DB already says refund_pending)
///   refund.processed  — money has reached the customer's account →
///                       walk Payment to `refunded`, set refundedAt.
///   refund.failed     — refund couldn't go through (invalid card,
///                       closed account, bank rejection). Roll the
///                       Payment back to `paid` so the booking still
///                       reflects that we hold the money — the admin
///                       sees the failureReason and decides next steps
///                       (manual bank transfer, store credit, etc.).
async function handleRefundWebhook(event, payload) {
  const refund = payload?.payload?.refund?.entity;
  if (!refund) return { ok: true, ignored: true };

  /// Lookup by Razorpay payment id — the refund payload always
  /// includes the original payment_id it was created against.
  const payment = await prisma.payment.findFirst({
    where: { providerPaymentId: refund.payment_id },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) return { ok: true, ignored: true };

  if (event === 'refund.processed') {
    if (payment.status === 'refunded') return { ok: true, idempotent: true };
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'refunded',
          refundedAt: new Date(),
          /// Refund amount in our model is whole rupees; Razorpay
          /// gives us paise.
          refundAmount: Math.round(refund.amount / 100),
        },
      });
      await syncBookingRollup(tx, payment.bookingId);
    });
    return { ok: true };
  }

  if (event === 'refund.failed') {
    /// Roll back to `paid` so the booking's rollup reflects truth —
    /// Razorpay has the money, the customer doesn't (yet). Admin can
    /// retry or arrange an out-of-band transfer.
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'paid',
          failureReason:
            refund.error_description ??
            refund.notes?.reason ??
            'Refund failed at Razorpay',
        },
      });
      await syncBookingRollup(tx, payment.bookingId);
    });
    return { ok: true };
  }

  /// refund.created and any other refund.* events are informational —
  /// our state machine doesn't need them.
  return { ok: true, ignored: true };
}

/// Backup path for add-on charges — mirrors the booking-payment webhook
/// branch but settles BookingAddOn rows instead of the booking rollup.
async function handleAddOnWebhook(event, entity) {
  if (event !== 'payment.captured' && event !== 'payment.failed') {
    return { ok: true, ignored: true };
  }
  const orderId = entity.order_id;
  const bookingId = Number(entity.notes?.bookingId);
  if (!orderId || !Number.isFinite(bookingId)) return { ok: true, ignored: true };

  const payment = await prisma.payment.findFirst({
    where: { bookingId, providerOrderId: orderId, purpose: 'addons' },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) return { ok: true, ignored: true };

  if (event === 'payment.captured' && payment.status !== 'paid') {
    await prisma.$transaction(async (tx) => {
      await applyAddOnCapture(tx, payment, entity.id);
    });
  } else if (event === 'payment.failed' && payment.status !== 'paid') {
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'failed', failureReason: entity.error_description ?? 'Payment failed' },
    });
  }
  return { ok: true };
}

/// Backup path for the partner onboarding fee — fires when the app
/// closes before the explicit /verify call lands. Idempotent: if the
/// row is already paid we no-op.
async function handlePartnerOnboardingWebhook(event, entity) {
  if (event !== 'payment.captured' && event !== 'payment.failed') {
    return { ok: true, ignored: true };
  }

  const partnerId = Number(entity.notes?.partnerId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    return { ok: true, ignored: true };
  }
  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: { id: true, paymentStatus: true, onboardingFeeOrderId: true },
  });
  if (!partner) return { ok: true, ignored: true };
  if (partner.onboardingFeeOrderId !== entity.order_id) {
    /// Replay protection — the webhook order id must match the one
    /// we minted for this partner.
    return { ok: true, ignored: true };
  }

  if (event === 'payment.failed') {
    /// We don't fail-flip the partner row here; the partner can just
    /// retry pay via the app. Logging it on the order id is enough.
    return { ok: true };
  }

  if (partner.paymentStatus === 'paid') {
    return { ok: true, idempotent: true };
  }

  await prisma.partner.update({
    where: { id: partner.id },
    data: {
      paymentStatus: 'paid',
      onboardingFeePaidAt: new Date(),
      onboardingFeePaymentId: entity.id,
      rejectedReason: null,
    },
  });
  return { ok: true };
}
