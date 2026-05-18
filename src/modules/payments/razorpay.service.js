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
  const paid = await tx.payment.findFirst({
    where: { bookingId, status: { in: ['paid', 'refunded'] } },
    orderBy: { createdAt: 'desc' },
  });
  const latest =
    paid ??
    (await tx.payment.findFirst({
      where: { bookingId },
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
      await syncBookingRollup(tx, booking.id);
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

  return result;
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
exports.refundForBooking = async ({ bookingId, reason } = {}, tx = null) => {
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
    },
    orderBy: { paidAt: 'desc' },
  });
  if (!payment) {
    /// Either unpaid (so nothing to refund — silent no-op) or already
    /// in refund flow (idempotency guard).
    return null;
  }

  /// Razorpay refund API expects amount in paise. We refund the full
  /// captured amount; partial refunds aren't part of this flow yet.
  const amountPaise = payment.amount * 100;
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
        refundAmount: payment.amount,
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
    amount: payment.amount,
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
    /// Backup trigger — fires when verify never ran (e.g. user closed
    /// the app mid-Razorpay-flow but the payment still captured).
    /// Idempotent with the verify-path trigger via the queue's
    /// `wave:{bookingId}:{n}` job ids.
    await triggerDispatchIfNeeded(bookingId);
  } else if (event === 'payment.failed' && payment.status !== 'paid') {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: 'failed',
          failureReason: entity.error_description ?? 'Payment failed',
        },
      });
      await syncBookingRollup(tx, bookingId);
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
