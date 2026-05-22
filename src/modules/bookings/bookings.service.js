const crypto = require('crypto');
const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const couponsService = require('../coupons/coupons.service');
const dispatcher = require('../dispatch/dispatcher');
const dispatchQueue = require('../dispatch/queue');
const dispatchRegistry = require('../dispatch/registry');
const earningsService = require('../payments/earnings.service');
const razorpayService = require('../payments/razorpay.service');
const cityResolver = require('../geography/city-resolver');
const { computeFare } = require('../../utils/fare');

/// Best-effort refund kick — called from every CANCELLED transition.
/// Wrapped so a Razorpay outage / config gap can't roll back a cancel
/// that has already committed to the DB. The webhook reconciliation
/// path (`handleRefundWebhook`) will eventually catch up if the call
/// failed; the admin can also manually re-trigger via an admin tool
/// added later.
const tryRefund = async (bookingId, reason) => {
  try {
    return await razorpayService.refundForBooking({ bookingId, reason });
  } catch (err) {
    console.warn(`Refund kick failed for booking ${bookingId}: ${err.message}`);
    return null;
  }
};

/// 4-digit handoff code, never starts with 0 so it stays a four-character
/// string when the customer reads it out and the partner types it.
const generateOtp = () => String(1000 + crypto.randomInt(0, 9000));

/// BYOP pay-after-accept window. When a partner accepts a booking
/// with `offeredPrice`, the customer has this long to pay before the
/// booking auto-cancels. 3 minutes balances "long enough to open
/// Razorpay and complete the flow on a slow network" against "short
/// enough that a partner isn't held in limbo while the customer
/// disappears". Tune via env if needed.
const BYOP_PAYMENT_HOLD_MS = 3 * 60 * 1000;

// ── Partner helpers ──────────────────────────────────────────────────────────

const haversineKm = (a, b) => {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};

/// Mirror of `dispatcher.DISPATCH_WAVES` for the legacy pull path
/// (used when Redis isn't configured). Keep these two in sync —
/// they encode the same 10s/10s/10s cadence so a dev env without
/// Redis behaves the same as the production push path.
const DISPATCH_WAVES = [
  { wave: 1, radiusKm: 3, startsAtSec: 0, endsAtSec: 10 },
  { wave: 2, radiusKm: 5, startsAtSec: 10, endsAtSec: 20 },
  { wave: 3, radiusKm: 7, startsAtSec: 20, endsAtSec: 30 },
];
const DISPATCH_TOTAL_MS = 30 * 1000;
const SCHEDULE_DISPATCH_LEAD_MS = 30 * 60 * 1000;

const broadcastStartFor = (booking) => {
  if (booking.isInstant || booking.offeredPrice != null) return new Date(booking.createdAt);
  return new Date(new Date(booking.scheduledAt).getTime() - SCHEDULE_DISPATCH_LEAD_MS);
};

const dispatchWindowFor = (booking, now = new Date()) => {
  const start = broadcastStartFor(booking);
  const elapsedMs = now.getTime() - start.getTime();
  if (elapsedMs < 0) return null;
  if (elapsedMs >= DISPATCH_TOTAL_MS) return null;
  const elapsedSec = elapsedMs / 1000;
  return DISPATCH_WAVES.find((w) => elapsedSec >= w.startsAtSec && elapsedSec < w.endsAtSec) ?? null;
};

const expireBroadcasts = async (now = new Date()) => {
  const pending = await prisma.booking.findMany({
    where: {
      status: 'PENDING',
      partnerId: null,
      dispatchStatus: { in: ['waiting', 'broadcasting'] },
      OR: [
        { isInstant: true },
        { offeredPrice: { not: null } },
        { scheduledAt: { lte: new Date(now.getTime() + SCHEDULE_DISPATCH_LEAD_MS - DISPATCH_TOTAL_MS) } },
      ],
    },
    select: {
      id: true,
      isInstant: true,
      offeredPrice: true,
      scheduledAt: true,
      createdAt: true,
      notes: true,
      /// Pull `couponId` so we can refund the redemption when the
      /// booking auto-cancels — without this, every "no partner
      /// accepted" event would leave the coupon's `usedCount` ticked
      /// up even though the customer never received service.
      couponId: true,
    },
    take: 200,
  });

  const expired = pending.filter((b) => now.getTime() - broadcastStartFor(b).getTime() >= DISPATCH_TOTAL_MS);
  if (expired.length === 0) return;

  /// Per-booking transition so the coupon refund is gated on the
  /// actual cancel, not just on what we read at findMany time. A
  /// partner can race in and accept between our read and the write —
  /// in that case `updateMany` returns count 0 for that row and we
  /// skip the refund (the booking is now legitimately in flight).
  /// Track which bookings actually transitioned so we can kick the
  /// payment refund AFTER the transaction commits.
  const cancelledIds = [];
  await prisma.$transaction(async (tx) => {
    for (const b of expired) {
      const result = await tx.booking.updateMany({
        where: { id: b.id, status: 'PENDING', partnerId: null },
        data: {
          status: 'CANCELLED',
          dispatchStatus: 'no_partner_found',
          dispatchRadiusKm: 7,
          dispatchWave: 3,
          noPartnerReason: 'No partner accepted within 3km, 5km, or 7km broadcast windows.',
        },
      });
      if (result.count > 0) {
        cancelledIds.push(b.id);
        if (b.couponId != null) {
          await couponsService.refundForBooking({ couponId: b.couponId, tx });
        }
      }
    }
  });

  /// Kick payment refunds outside the transaction. Best-effort — a
  /// Razorpay outage never blocks the cancel itself.
  for (const bid of cancelledIds) {
    try {
      await razorpayService.refundForBooking({
        bookingId: bid,
        reason: 'No partner found within broadcast window',
      });
    } catch (err) {
      console.warn(`Refund kick failed for booking ${bid}: ${err.message}`);
    }
  }
};

const partnerHasActiveJob = async (partnerId) => {
  const active = await prisma.booking.findFirst({
    where: {
      partnerId: Number(partnerId),
      status: { in: ['CONFIRMED', 'IN_PROGRESS'] },
    },
    select: { id: true },
  });
  return Boolean(active);
};

const PARTNER_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  /// Service.categoryId is needed for per-category commission lookup
  /// so the partner-app can show the actual partner share / platform
  /// commission split on the bill view.
  items: { include: { service: { select: { categoryId: true } } } },
  /// Join the canonical address row. New bookings store address only
  /// via `customerAddressId`; the snapshot columns on Booking are
  /// nullable + legacy. Including the relation here lets every shape
  /// helper read display fields from one source of truth.
  customerAddress: {
    select: {
      id: true,
      label: true,
      addressLine: true,
      city: true,
      pincode: true,
      lat: true,
      lng: true,
    },
  },
  rating: {
    select: {
      id: true,
      stars: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
    },
  },
};

/// Resolve the display address for a booking with the FK-first
/// strategy. Reads from the joined `customerAddress` row when
/// present; falls back to the legacy snapshot columns for
/// historical rows whose FK never got populated. Returns a stable
/// `{ label, line, city, pincode, lat, lng }` shape every consumer
/// can rely on.
const resolveBookingAddress = (b) => {
  const a = b.customerAddress;
  if (a) {
    return {
      label: a.label,
      line: a.addressLine,
      city: a.city,
      pincode: a.pincode ?? null,
      lat: a.lat ?? b.lat ?? null,
      lng: a.lng ?? b.lng ?? null,
    };
  }
  /// Legacy fallback — pre-refactor bookings still have these.
  return {
    label: b.addressLabel ?? 'Home',
    line: b.addressLine ?? '',
    city: b.city ?? '',
    pincode: null,
    lat: b.lat ?? null,
    lng: b.lng ?? null,
  };
};

/// Load category → partnerPct as a Map for synchronous lookup inside
/// `partnerShape`. One query covers an entire list-shaping pass, so
/// even a 50-booking response only costs a single round-trip.
const loadCommissionMap = async () => {
  const rules = await prisma.commissionRule.findMany({
    select: { categoryId: true, partnerPct: true },
  });
  return new Map(rules.map((r) => [r.categoryId, r.partnerPct]));
};

/// Resolve the booking's fare breakdown. Prefers the persisted snapshot
/// columns (`grandTotal`, `gstAmount`, `platformFee`) set at create time
/// via `computeFare`. For legacy rows where those columns are null, we
/// re-derive on the fly from `subtotal/discount/offeredPrice` using the
/// same `computeFare` helper — so the partner-app gets a consistent
/// breakdown regardless of when the booking was created.
const resolveFare = (b) => {
  const persisted = {
    grandTotal: b.grandTotal,
    total: b.total,
    gstAmount: b.gstAmount,
    platformFee: b.platformFee,
  };
  const anyMissing =
    persisted.grandTotal == null ||
    persisted.gstAmount == null ||
    persisted.platformFee == null;
  if (!anyMissing) return persisted;
  const derived = computeFare({
    subtotal: b.subtotal,
    discount: b.discount ?? 0,
    offeredPrice: b.offeredPrice ?? null,
  });
  return {
    grandTotal: persisted.grandTotal ?? derived.grandTotal,
    total: persisted.total ?? derived.total,
    gstAmount: persisted.gstAmount ?? derived.gstAmount,
    platformFee: persisted.platformFee ?? derived.platformFee,
  };
};

/// `commissionMap` is an optional Map<categoryId, partnerPct>. When
/// absent, falls back to the platform default (80%) so the helper
/// remains usable in code paths that don't prefetch commission rules.
const partnerShape = (b, partnerCoords, commissionMap) => {
  const addr = resolveBookingAddress(b);
  const bookingLat = addr.lat;
  const bookingLng = addr.lng;
  const km =
    partnerCoords && bookingLat != null && bookingLng != null
      ? haversineKm(partnerCoords, { lat: bookingLat, lng: bookingLng })
      : 0;

  const services = (b.items ?? []).map((i) => ({
    name: i.serviceName,
    qty: i.qty,
    price: i.basePrice,
  }));

  const fare = resolveFare(b);
  const primaryCategoryId = b.items?.[0]?.service?.categoryId ?? null;
  const partnerCommissionPct =
    (commissionMap && primaryCategoryId != null
      ? commissionMap.get(primaryCategoryId)
      : undefined) ?? 80;
  /// Floor matches the standard payout-rounding direction used by
  /// earnings.creditForBooking — partner gets at most their fair
  /// share, never more than the rule says.
  const partnerEarning = Math.floor((fare.total * partnerCommissionPct) / 100);

  const statusMap = {
    PENDING: 'incoming',
    CONFIRMED: 'enroute',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
  };

  return {
    id: String(b.id),
    service: b.items?.[0]?.serviceName ?? 'Service',
    services,
    customerName: b.customer?.name ?? 'Customer',
    customerPhone: b.customer?.phone ?? '',
    address: [addr.line, addr.city].filter(Boolean).join(', '),
    lat: bookingLat,
    lng: bookingLng,
    scheduledAt: b.scheduledAt,
    slotLabel: b.slotLabel ?? '',
    isInstant: b.isInstant ?? false,
    status: statusMap[b.status] ?? 'incoming',
    subtotal: b.subtotal,
    discount: b.discount ?? 0,
    /// Authoritative fare breakdown. Reads the persisted snapshot when
    /// available, otherwise re-derives via `computeFare` so legacy rows
    /// (created before these columns existed) don't surface NaN/0 on
    /// the partner's bill view.
    total: fare.total,
    grandTotal: fare.grandTotal,
    gstAmount: fare.gstAmount,
    platformFee: fare.platformFee,
    /// Partner-side earnings split for THIS booking. `partnerEarning`
    /// is what the partner takes home for the job; `platformCommission`
    /// is what the platform keeps out of `total`. GST and platformFee
    /// are separate from this commission split — those come out of the
    /// customer's payment before the partner's share is computed.
    partnerCommissionPct,
    partnerEarning,
    platformCommission: fare.total - partnerEarning,
    offeredPrice: b.offeredPrice ?? null,
    /// Payment lifecycle surfaced to the partner app so the partner can
    /// see whether the customer has paid yet — drives the "Awaiting
    /// payment" / "Paid" pill on the partner's booking views.
    paymentStatus: b.paymentStatus ?? 'unpaid',
    paymentMethod: b.paymentMethod ?? null,
    paidAt: b.paidAt ?? null,
    /// BYOP hold deadline — partner-side timer for the "waiting on
    /// customer to pay" state. The job is locked (no Mark Arrival)
    /// until paymentStatus flips to 'paid' OR this deadline elapses
    /// (in which case the worker auto-cancels and the booking
    /// disappears from the partner's list).
    paymentDeadlineAt: b.paymentDeadlineAt ?? null,
    dispatchStatus: b.dispatchStatus,
    dispatchRadiusKm: b.dispatchRadiusKm ?? null,
    dispatchWave: b.dispatchWave ?? 0,
    noPartnerReason: b.noPartnerReason ?? null,
    distanceKm: Math.round(km * 10) / 10,
    etaMins: km > 0 ? Math.max(1, Math.ceil((km / 25) * 60)) : 0,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    /// Lifecycle timestamps — partner-app uses these to render the
    /// earnings screen (jobs grouped by `jobCompletedAt`, duration
    /// computed from start↔complete) and to label active-job timers.
    /// Null until the corresponding transition has happened.
    jobStartedAt: b.jobStartedAt ?? null,
    jobCompletedAt: b.jobCompletedAt ?? null,
  };
};

const BOOKING_INCLUDE = {
  items: {
    include: {
      service: {
        select: {
          id: true,
          name: true,
          imageUrl: true,
          durationMins: true,
          categoryId: true,
        },
      },
    },
  },
  /// Same FK-first join the partner/admin shapes use — pulls the
  /// authoritative address from `customer_addresses` so consumers
  /// never have to read the legacy snapshot columns directly.
  customerAddress: {
    select: {
      id: true,
      label: true,
      addressLine: true,
      city: true,
      pincode: true,
      lat: true,
      lng: true,
    },
  },
  rating: {
    select: {
      id: true,
      stars: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
    },
  },
};

const shape = (b) => {
  const addr = resolveBookingAddress(b);
  return {
  id: b.id,
  customerId: b.customerId,
  status: b.status,
  scheduledAt: b.scheduledAt,
  slotLabel: b.slotLabel,
  isInstant: b.isInstant ?? false,
  address: {
    /// `id` lets the client correlate this back to a row in
    /// `customer_addresses` (e.g. for editing the saved address
    /// directly). Null for legacy bookings that pre-date the FK.
    id: b.customerAddress?.id ?? b.customerAddressId ?? null,
    label: addr.label,
    line: addr.line,
    city: addr.city,
    pincode: addr.pincode,
    lat: addr.lat,
    lng: addr.lng,
  },
  subtotal: b.subtotal,
  discount: b.discount,
  total: b.total,
  /// Tax + platform fee breakdown — snapshot at booking time. The
  /// customer-app shows these as separate line items in the cart and
  /// booking details. `grandTotal` is the customer-facing amount
  /// Razorpay charges; `total` is the partner-facing job amount.
  gstAmount: b.gstAmount ?? 0,
  platformFee: b.platformFee ?? 0,
  grandTotal: b.grandTotal && b.grandTotal > 0 ? b.grandTotal : b.total,
  offeredPrice: b.offeredPrice ?? null,
  /// Payment rollup — denormalised cache of the latest Payment row
  /// (see `payments` table). The customer app reads these to render
  /// the "Paid" / "Awaiting payment" pill on the bookings list. The
  /// Razorpay-specific order id is no longer surfaced here — the
  /// customer app gets it from the live `/payments/razorpay/order`
  /// response when the user taps "Pay now".
  paymentStatus: b.paymentStatus ?? 'unpaid',
  paymentMethod: b.paymentMethod ?? null,
  paidAt: b.paidAt ?? null,
  /// BYOP pay-after-accept window. Surfaced so the customer-app can
  /// drive the 3-minute countdown on the accepted screen. Null for
  /// non-BYOP bookings.
  paymentDeadlineAt: b.paymentDeadlineAt ?? null,
  /// Coupon redemption snapshot. `couponDiscount` is the rupee amount
  /// deducted at booking time (captured then to immunise from later
  /// edits to the coupon row).
  couponCode: b.couponCode ?? null,
  couponDiscount: b.couponDiscount ?? null,
  /// Job handoff codes — visible to the customer only. The customer
  /// reads these aloud to the partner at start / completion. Once the
  /// partner has verified the code we record the timestamp; UI can use
  /// the timestamp to grey out / hide the code after handoff.
  jobStartOtp: b.jobStartOtp ?? null,
  jobStartedAt: b.jobStartedAt ?? null,
  jobCompleteOtp: b.jobCompleteOtp ?? null,
  jobCompletedAt: b.jobCompletedAt ?? null,
  rating: b.rating
    ? {
        id: b.rating.id,
        stars: b.rating.stars,
        comment: b.rating.comment,
        createdAt: b.rating.createdAt,
        updatedAt: b.rating.updatedAt,
      }
    : null,
  notes: b.notes,
  items: (b.items ?? []).map((it) => ({
    id: it.id,
    serviceId: it.serviceId,
    name: it.serviceName,
    basePrice: it.basePrice,
    qty: it.qty,
    image: it.service?.imageUrl ?? null,
    durationMins: it.service?.durationMins ?? null,
  })),
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
  };
};

exports.create = async ({ customerId, payload, idempotencyKey = null }) => {
  /// Idempotency-Key dedup. If the client sends the same key twice
  /// (e.g. retried Pay button on a flaky network), return the original
  /// booking instead of inserting a new row. Falls open when Redis is
  /// unavailable — in that case we don't dedup and the legacy
  /// double-create-on-retry behaviour returns. Better than blocking
  /// real bookings on a Redis hiccup.
  if (idempotencyKey) {
    const cachedId = await dispatchRegistry.getIdempotentBookingId(
      customerId,
      idempotencyKey,
    );
    if (cachedId) {
      const existing = await prisma.booking.findUnique({
        where: { id: cachedId },
        include: BOOKING_INCLUDE,
      });
      if (existing && existing.customerId === customerId) {
        return shape(existing);
      }
      /// Cached id pointed at a row that's gone (deleted, or it was
      /// for a different customer somehow) — fall through and create
      /// fresh. Worst case: one unintended duplicate, which is no
      /// worse than today's behaviour.
    }
    /// Lock so two concurrent retries don't both miss the cache and
    /// both insert. Best effort — if Redis is down, the lock just
    /// no-ops and we accept the risk of a single duplicate during
    /// the outage.
    const got = await dispatchRegistry.acquireIdempotencyLock(
      customerId,
      idempotencyKey,
    );
    if (!got) {
      /// Another request with the same key is mid-create. Wait briefly
      /// then re-check the cache; usually the in-flight request will
      /// have stored the result by then.
      await new Promise((r) => setTimeout(r, 250));
      const retryId = await dispatchRegistry.getIdempotentBookingId(
        customerId,
        idempotencyKey,
      );
      if (retryId) {
        const existing = await prisma.booking.findUnique({
          where: { id: retryId },
          include: BOOKING_INCLUDE,
        });
        if (existing && existing.customerId === customerId) return shape(existing);
      }
      /// Lock holder didn't finish in time — proceed anyway. Slightly
      /// risks a duplicate but never blocks a legit retry.
    }
  }

  // Pull live service rows so we always price + name from the source of truth
  // (the cart on the client is just a hint).
  const serviceIds = payload.items.map((i) => i.serviceId);
  const services = await prisma.service.findMany({
    where: { id: { in: serviceIds } },
  });
  const map = new Map(services.map((s) => [s.id, s]));

  /// Resolve the address. A saved-address row is used only when the
  /// client explicitly passes `customerAddressId`. Inline address
  /// fields are treated as a one-time booking snapshot and do NOT
  /// create a CustomerAddress row. That keeps GPS/current-location
  /// fetches from polluting the customer's saved addresses; only the
  /// dedicated Add address flow writes to `customer_addresses`.
  let saved;
  let inlineAddress = null;
  if (payload.customerAddressId) {
    saved = await prisma.customerAddress.findUnique({
      where: { id: Number(payload.customerAddressId) },
    });
    if (!saved || saved.customerId !== customerId) {
      throw ApiError.notFound('Saved address not found');
    }
  } else {
    inlineAddress = {
      label: payload.addressLabel ?? 'Home',
      addressLine: payload.addressLine,
      city: payload.city,
      pincode: payload.pincode ?? null,
      cityId: payload.city ? await cityResolver.resolve(payload.city) : null,
      lat: payload.lat ?? null,
      lng: payload.lng ?? null,
    };
  }

  /// Booking-level cityId mirrors the address's cityId for the
  /// geography filter on admin lists. Falls back to a fresh resolve
  /// when the saved row predates the geography backfill.
  const bookingCityId =
    saved?.cityId
    ?? inlineAddress?.cityId
    ?? (saved?.city ? await cityResolver.resolve(saved.city) : null);
  const bookingLat = saved?.lat ?? inlineAddress?.lat ?? null;
  const bookingLng = saved?.lng ?? inlineAddress?.lng ?? null;

  const missing = serviceIds.filter((id) => !map.has(id));
  if (missing.length > 0) {
    throw ApiError.badRequest(`Unknown service ids: ${missing.join(', ')}`);
  }

  const inactive = services.filter((s) => !s.active);
  if (inactive.length > 0) {
    throw ApiError.badRequest(
      `One or more services are no longer available: ${inactive.map((s) => s.name).join(', ')}`,
    );
  }

  const items = payload.items.map((i) => {
    const svc = map.get(i.serviceId);
    return {
      serviceId: i.serviceId,
      serviceName: svc.name,
      basePrice: svc.basePrice,
      qty: i.qty,
    };
  });

  const subtotal = items.reduce((s, i) => s + i.basePrice * i.qty, 0);
  const baseDiscount = payload.discount ?? 0;

  /// Auto-cancel the customer's previous still-in-flight booking
  /// attempts before creating a new one. Without this, a customer
  /// who taps Back from the BYOP slider and resubmits with a
  /// different price ends up with 3-4 PENDING rows broadcasting in
  /// parallel — wasted dispatcher work, partner offers from the
  /// abandoned attempts, and noise in the admin booking history.
  ///
  /// Scope of "stale attempt":
  ///   - belongs to this customer
  ///   - status PENDING (never accepted)
  ///   - partnerId is null (nobody has claimed it yet)
  ///   - paymentStatus is NOT paid (we'd never wipe a paid booking
  ///     mid-flight; that path is the BYOP pay-on-accept window
  ///     handled by the dispatcher's payment_expire job)
  ///
  /// We surface the bookingId list before the transaction so the
  /// dispatch-queue cancellation can fire after the DB commits
  /// (queue ops aren't transactional — running them inside the txn
  /// risks a hanging job if the txn rolls back).
  const stalePrev = await prisma.booking.findMany({
    where: {
      customerId,
      status: 'PENDING',
      partnerId: null,
      paymentStatus: { not: 'paid' },
    },
    select: { id: true, couponId: true },
  });

  /// Coupon redemption + booking insert wrapped in a single transaction
  /// so a coupon usage is never burned without a corresponding booking
  /// row. `redeemForBooking` re-validates the coupon against the same
  /// canonical subtotal we computed above (the customer's `applyForCart`
  /// call earlier is just a UI preview — the source of truth is here).
  const booking = await prisma.$transaction(async (tx) => {
    /// Cancel the stale rows we found just above, in the same txn
    /// as the new booking insert so the customer can never end up
    /// with two live PENDING attempts even on race.
    if (stalePrev.length > 0) {
      await tx.booking.updateMany({
        where: { id: { in: stalePrev.map((b) => b.id) } },
        data: {
          status: 'CANCELLED',
          dispatchStatus: 'superseded',
          noPartnerReason: 'Customer placed a fresh booking — previous attempt superseded.',
        },
      });
      /// Refund any coupon redemptions on the cancelled rows so the
      /// customer's promo isn't burned by a back-and-retry loop.
      for (const prev of stalePrev) {
        if (prev.couponId != null) {
          await couponsService.refundForBooking({ couponId: prev.couponId, tx });
        }
      }
    }

    let couponData = null;
    if (payload.couponCode) {
      couponData = await couponsService.redeemForBooking({
        code: payload.couponCode,
        subtotal,
        tx,
      });
    }

    const couponDiscount = couponData?.discount ?? 0;
    const totalDiscount = baseDiscount + couponDiscount;
    /// Compute the full breakdown (18% GST + 2% platform fee) once,
    /// at booking creation, and snapshot every line item on the row.
    /// `total` stays the partner-facing job amount (used by earnings
    /// + commission); `grandTotal` is what Razorpay charges.
    const fare = computeFare({
      subtotal,
      discount: totalDiscount,
      offeredPrice: payload.offeredPrice ?? null,
    });

    return tx.booking.create({
      data: {
        customerId,
        status: 'PENDING',
        scheduledAt: new Date(payload.scheduledAt),
        slotLabel: payload.slotLabel,
        isInstant: payload.isInstant ?? false,
        customerAddressId: saved?.id ?? null,
        cityId: bookingCityId,
        addressLabel: inlineAddress?.label ?? null,
        addressLine: inlineAddress?.addressLine ?? null,
        city: inlineAddress?.city ?? null,
        /// Lat/lng kept on the booking row itself for the dispatcher's
        /// GEOSEARCH hot path. For saved addresses this mirrors the
        /// saved row; for one-time addresses it stores the snapshot.
        lat: bookingLat,
        lng: bookingLng,
        subtotal,
        discount: totalDiscount,
        total: fare.total,
        gstAmount: fare.gstAmount,
        platformFee: fare.platformFee,
        grandTotal: fare.grandTotal,
        offeredPrice: payload.offeredPrice ?? null,
        couponId: couponData?.couponId ?? null,
        couponCode: couponData?.couponCode ?? null,
        couponDiscount: couponData ? couponData.discount : null,
        dispatchStatus: 'waiting',
        jobStartOtp: generateOtp(),
        jobCompleteOtp: generateOtp(),
        notes: payload.notes ?? null,
        items: { create: items },
      },
      include: BOOKING_INCLUDE,
    });
  });

  /// Tear down any dispatch jobs queued for the superseded rows.
  /// `cancelAllForBooking` is idempotent + no-ops when the queue is
  /// disabled, so we can fan-out without worrying about config.
  /// Done after the txn commits because BullMQ ops aren't
  /// transactional — running them inside a txn risks a stranded
  /// queue entry if the txn rolls back.
  for (const prev of stalePrev) {
    dispatcher.cancelAllForBooking(prev.id).catch((err) => {
      console.warn(
        `Failed to tear down dispatch for superseded booking ${prev.id}: ${err.message}`,
      );
    });
  }

  /// Hand the booking off to the BullMQ dispatcher when the queue is
  /// enabled (REDIS_URL set). The dispatcher schedules the three wave
  /// jobs and the expirer; partners who are connected via socket get
  /// the offer pushed, and the legacy partnerIncoming polling reads
  /// the same Redis-backed visibleTo set so the partner-app keeps
  /// working before it's converted to sockets.
  ///
  /// HOWEVER: instant fixed-price bookings (`isInstant && offeredPrice
  /// == null`) require the customer to pay UPFRONT. Broadcasting to
  /// partners before payment lands is wasteful — if the customer
  /// abandons checkout, partners see a phantom offer and we burn
  /// dispatch capacity for nothing. For that path, dispatch is gated
  /// inside `razorpay.service.js` and only enqueued once the payment
  /// is verified. BYOP (`offeredPrice != null`) explicitly broadcasts
  /// FIRST and the customer pays after acceptance, so it dispatches
  /// immediately. Scheduled non-instant bookings also dispatch at
  /// create-time because their wave fires far in the future
  /// (scheduledAt - 30min), and the wave handler re-checks status.
  ///
  /// We deliberately swallow errors here — a queue hiccup must not
  /// roll back a committed booking. The legacy lazy expirer (still
  /// wired inside partnerIncoming/partnerAccept when REDIS_URL is
  /// unset) is the fallback path.
  const dispatchOnCreate =
    !(booking.isInstant && booking.offeredPrice == null);
  if (dispatchQueue.enabled() && dispatchOnCreate) {
    try {
      await dispatcher.scheduleAllForBooking(booking);
    } catch (err) {
      console.warn(`Dispatch enqueue failed for booking ${booking.id}: ${err.message}`);
    }
  }

  /// Persist the idempotency mapping AFTER the booking row is
  /// committed — same key resends will now hit the cache and return
  /// this booking instead of inserting another. Lock release is
  /// independent so even if recording fails, no future retry stalls.
  if (idempotencyKey) {
    await Promise.all([
      dispatchRegistry.recordIdempotencyResult(customerId, idempotencyKey, booking.id),
      dispatchRegistry.releaseIdempotencyLock(customerId, idempotencyKey),
    ]);
  }

  /// Surface the new booking on the admin bell. Lazy-required so the
  /// notifications module can require `bookings.service.js` (e.g. for
  /// shape helpers) later without a cycle. Soft-fail — the helper
  /// already swallows errors, but the outer try is belt-and-braces.
  try {
    const adminNotifs = require('../notifications/admin-notifications.service');
    const headService = booking.items?.[0]?.serviceName ?? 'a service';
    void adminNotifs.notifyAllAdmins({
      type: adminNotifs.TYPES.BOOKING_NEW,
      title: `New booking #${booking.id}`,
      body: `${booking.customer?.name ?? 'A customer'} booked ${headService}${
        booking.isInstant ? ' (Instant)' : ` for ${booking.slotLabel ?? 'a slot'}`
      }.`,
      href: `/bookings/history/${booking.id}`,
      bookingId: booking.id,
      customerId: booking.customerId,
    });
  } catch { /* notification surface should never block booking creation */ }

  return shape(booking);
};

exports.listMine = async ({ customerId, status, bucket }) => {
  const where = { customerId };
  if (status) where.status = status;

  if (bucket === 'upcoming') {
    where.status = { in: ['PENDING', 'CONFIRMED', 'IN_PROGRESS'] };
  } else if (bucket === 'past') {
    /// Past = completed jobs + cancellations the user can act on.
    /// Hide system-driven cancellations (no-pay timeout, fresh-attempt
    /// supersede, no-partner-accepted broadcast expiry) — those rows
    /// populate `noPartnerReason`. User-driven cancels and admin-driven
    /// cancels go through `notes` and leave `noPartnerReason` null, so
    /// they still appear here. The rows stay in the DB for audit /
    /// support / fraud detection — we just stop surfacing them to the
    /// customer who didn't make the decision.
    delete where.status;
    where.OR = [
      { status: 'COMPLETED' },
      { status: 'CANCELLED', noPartnerReason: null },
    ];
  }

  /// Most-recent-first across both buckets — a customer who just
  /// placed a booking expects to see it pinned at the top of
  /// Upcoming, and Past already used `createdAt: 'desc'` so the
  /// ordering is now consistent. Previously Upcoming sorted by
  /// `scheduledAt: 'asc'`, which buried a fresh same-day booking
  /// underneath whatever was scheduled even further out.
  const items = await prisma.booking.findMany({
    where,
    include: BOOKING_INCLUDE,
    orderBy: { createdAt: 'desc' },
  });
  return items.map(shape);
};

exports.getOwn = async ({ customerId, id }) => {
  const b = await prisma.booking.findUnique({ where: { id }, include: BOOKING_INCLUDE });
  if (!b || b.customerId !== customerId) throw ApiError.notFound('Booking not found');
  return shape(b);
};

exports.rateBooking = async ({ customerId, id, stars, comment }) => {
  const b = await prisma.booking.findUnique({
    where: { id },
    select: { customerId: true, status: true, partnerId: true, rating: { select: { id: true } } },
  });
  if (!b || b.customerId !== customerId) throw ApiError.notFound('Booking not found');
  if (b.status !== 'COMPLETED') {
    throw ApiError.badRequest('Only completed bookings can be rated.');
  }
  if (b.partnerId == null) {
    throw ApiError.badRequest('No partner assigned to this booking.');
  }
  /// One-time only — once a rating exists the customer cannot change it.
  if (b.rating) {
    throw ApiError.badRequest('This booking has already been rated.');
  }
  const saved = await prisma.bookingRating.create({
    data: {
      bookingId: id,
      partnerId: b.partnerId,
      customerId,
      stars,
      comment: comment ?? null,
    },
  });

  /// Recompute the partner's aggregate after insert so reads never
  /// need a GROUP BY — single round-trip using Prisma aggregate.
  const agg = await prisma.bookingRating.aggregate({
    where: { partnerId: b.partnerId },
    _avg: { stars: true },
    _count: { stars: true },
  });
  await prisma.partner.update({
    where: { id: b.partnerId },
    data: {
      avgRating: Math.round((agg._avg.stars ?? 0) * 10) / 10,
      ratingCount: agg._count.stars,
    },
  });

  return {
    id: saved.id,
    bookingId: saved.bookingId,
    stars: saved.stars,
    comment: saved.comment,
    createdAt: saved.createdAt,
  };
};

exports.cancelOwn = async ({ customerId, id, reason }) => {
  const b = await prisma.booking.findUnique({
    where: { id },
    select: { customerId: true, status: true, couponId: true, partnerId: true },
  });
  if (!b || b.customerId !== customerId) throw ApiError.notFound('Booking not found');
  if (!['PENDING', 'CONFIRMED'].includes(b.status)) {
    throw ApiError.badRequest('Only pending or confirmed bookings can be cancelled.');
  }
  /// Wrap the cancel + coupon refund together — same reasoning as
  /// expireBroadcasts. A customer cancelling before the job runs
  /// hasn't consumed the promo, so `usedCount` should fall back.
  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.booking.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        notes: reason ? `Customer cancelled: ${reason}` : 'Customer cancelled',
      },
      include: BOOKING_INCLUDE,
    });
    if (b.couponId != null) {
      await couponsService.refundForBooking({ couponId: b.couponId, tx });
    }
    return next;
  });

  /// Outside the transaction so a Razorpay outage doesn't undo the
  /// cancel itself. tryRefund is a no-op when the booking is unpaid,
  /// so calling unconditionally is safe.
  await tryRefund(id, reason ?? 'Customer cancelled');

  /// Snapshot who was watching this offer BEFORE clearing Redis —
  /// cancelAllForBooking wipes the visibleTo set, so we must read
  /// the audience first or the broadcast below has nobody to notify.
  const offerAudience = await dispatchRegistry.listPartnersForBooking(id).catch(() => []);

  /// Tear down the dispatch queue + clear the partner offers set in
  /// Redis. Without this, partners who had the booking in their
  /// `partner:offers:{id}` set continue to see the JobAlert on
  /// their next 5s poll because that set isn't joined against booking.status.
  dispatcher.cancelAllForBooking(id).catch((err) => {
    console.warn(`Cancel dispatch teardown failed for booking ${id}: ${err.message}`);
  });

  /// Push a dispatch.claimed event to every partner who had this offer
  /// on their screen so the JobAlertModal closes immediately instead of
  /// waiting for the next 30s poll.
  dispatcher.broadcastClaimed(offerAudience, { bookingId: id, partnerId: null });

  /// If a partner had accepted this booking, tell them it's gone.
  /// Without this they'd find out only when their app polls and the
  /// row vanishes from /partner/mine — a notification lands instantly
  /// and gives them context for why.
  if (b.partnerId) {
    const notifications = require('../notifications/notifications.service');
    await notifications.create({
      partnerId: b.partnerId,
      type: 'job_cancelled',
      title: 'Booking cancelled',
      body: reason
        ? `Customer cancelled booking #${id}: ${reason}`
        : `Customer cancelled booking #${id}.`,
      bookingId: id,
    });
  }

  return shape(updated);
};

// ── Admin views ─────────────────────────────────────────────────────────────

const ADMIN_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  partner: { select: { id: true, name: true, phone: true, businessName: true } },
  /// Canonical city + state via the Geography table. We still keep
  /// the free-text `city` column on the booking row for the legacy
  /// "Area" cell, but the new Location column shows the real geo.
  cityRef: { select: { id: true, name: true, state: { select: { id: true, name: true, code: true } } } },
  /// FK-first address join. Booking row holds only the pointer;
  /// display comes from this relation. Fallback to legacy snapshot
  /// columns via `resolveBookingAddress` for pre-refactor rows.
  customerAddress: {
    select: {
      id: true,
      label: true,
      addressLine: true,
      city: true,
      pincode: true,
      lat: true,
      lng: true,
    },
  },
  items: {
    include: {
      service: {
        select: {
          id: true,
          name: true,
          imageUrl: true,
          categoryId: true,
          category: { select: { id: true, name: true } },
        },
      },
    },
  },
  rating: {
    select: { id: true, stars: true, comment: true, createdAt: true, updatedAt: true },
  },
  /// Most recent payment row only — admins typically want to see "what
  /// was the last attempt" (paid via Razorpay 5 min ago / pending /
  /// failed). Full audit trail is available via a separate endpoint
  /// when we add it.
  payments: {
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      amount: true,
      status: true,
      method: true,
      provider: true,
      providerOrderId: true,
      providerPaymentId: true,
      paidAt: true,
      failureReason: true,
      createdAt: true,
    },
  },
};

const adminShape = (b) => {
  const firstItem = b.items?.[0];
  const serviceName = firstItem?.serviceName ?? 'Service';
  const categoryId = firstItem?.service?.categoryId ?? '';
  const categoryName = firstItem?.service?.category?.name ?? '';
  const addr = resolveBookingAddress(b);
  const area = addr.line?.split(',')[0]?.trim() ?? addr.city;
  const partnerName = b.partner?.name ?? b.partner?.businessName ?? null;

  // Booking → admin status mapping. The DB enum is uppercase, the admin UI
  // uses lowercase variants and adds enroute/arrived as visual states for
  // CONFIRMED + IN_PROGRESS rows.
  const statusMap = {
    PENDING: 'pending',
    CONFIRMED: 'confirmed',
    IN_PROGRESS: 'in_progress',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
  };

  return {
    id: b.id,
    customerId: b.customerId,
    customer: b.customer?.name ?? 'Customer',
    customerPhone: b.customer?.phone ?? '',
    partnerId: b.partnerId,
    partner: partnerName,
    partnerPhone: b.partner?.phone ?? null,
    service: serviceName,
    categoryId,
    category: categoryName,
    amount: b.total,
    status: statusMap[b.status] ?? 'pending',
    /// Dispatch lifecycle so the Manual Dispatch admin page can read
    /// "broadcasting (wave 2 / 5 km)", "needs_admin_dispatch", or
    /// "no_partner_found" without joining anywhere.
    dispatchStatus: b.dispatchStatus ?? null,
    dispatchWave: b.dispatchWave ?? null,
    dispatchRadiusKm: b.dispatchRadiusKm ?? null,
    dispatchStartedAt: b.dispatchStartedAt ?? null,
    dispatchExpiresAt: b.dispatchExpiresAt ?? null,
    noPartnerReason: b.noPartnerReason ?? null,
    /// `city` keeps the legacy free-text value (so the existing
    /// "Area" / "City" copy in older tables doesn't change), while
    /// `cityName` / `state` come from the canonical Geography join.
    /// Address line/label now resolved from the customer_addresses
    /// FK with a fallback to the legacy snapshot columns.
    city: addr.city,
    cityName: b.cityRef?.name ?? addr.city ?? null,
    state: b.cityRef?.state?.name ?? null,
    stateCode: b.cityRef?.state?.code ?? null,
    area,
    addressLine: addr.line,
    addressLabel: addr.label,
    slotLabel: b.slotLabel,
    scheduledAt: b.scheduledAt,
    /// Granular lifecycle timestamps so the admin UI can render a
    /// real timeline (Created → Started → Completed) instead of
    /// faking it off `updatedAt`. For instant bookings these are
    /// what tell you when the job actually ran, since `scheduledAt`
    /// is auto-set to now+30min at creation and isn't meaningful.
    jobStartedAt: b.jobStartedAt ?? null,
    jobCompletedAt: b.jobCompletedAt ?? null,
    completedAt: b.jobCompletedAt ?? (b.status === 'COMPLETED' ? b.updatedAt : null),
    cancelledAt: b.status === 'CANCELLED' ? b.updatedAt : null,
    cancelReason: b.status === 'CANCELLED' ? b.notes : undefined,
    isInstant: b.isInstant ?? false,
    offeredPrice: b.offeredPrice,
    /// Pricing breakdown so the admin can audit the maths.
    subtotal: b.subtotal,
    discount: b.discount,
    gstAmount: b.gstAmount ?? 0,
    platformFee: b.platformFee ?? 0,
    grandTotal: b.grandTotal && b.grandTotal > 0 ? b.grandTotal : b.total,
    couponCode: b.couponCode,
    couponDiscount: b.couponDiscount,
    /// Payment rollup mirrored from the latest Payment row.
    paymentStatus: b.paymentStatus ?? 'unpaid',
    paymentMethod: b.paymentMethod ?? null,
    paidAt: b.paidAt ?? null,
    /// Recent payment attempts — chronological, latest first. Lets the
    /// admin see "Razorpay failed at 12:32, then cash recorded at
    /// 13:05" without leaving the page.
    payments: (b.payments ?? []).map((p) => ({
      id: p.id,
      amount: p.amount,
      status: p.status,
      method: p.method,
      provider: p.provider,
      providerOrderId: p.providerOrderId,
      providerPaymentId: p.providerPaymentId,
      paidAt: p.paidAt,
      failureReason: p.failureReason,
      createdAt: p.createdAt,
    })),
    rating: b.rating
      ? { id: b.rating.id, stars: b.rating.stars, comment: b.rating.comment, createdAt: b.rating.createdAt, updatedAt: b.rating.updatedAt }
      : null,
    notes: b.notes,
    items: (b.items ?? []).map((it) => ({
      id: it.id,
      serviceId: it.serviceId,
      service: it.serviceName,
      qty: it.qty,
      basePrice: it.basePrice,
      imageUrl: it.service?.imageUrl ?? null,
      category: it.service?.category?.name ?? '',
    })),
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
};

exports.adminList = async ({
  status,
  search,
  bookingId,
  customer,
  partner,
  partnerId,
  from,
  to,
  dispatchStatus,
  excludeStatus,
  scope,
  page = 1,
  pageSize = 25,
} = {}) => {
  const { applyScopeToWhere } = require('../../middlewares/adminScope');
  const where = {};
  if (dispatchStatus) {
    where.dispatchStatus = String(dispatchStatus);
  }
  if (status && status !== 'all') {
    const statusUpper = String(status).toUpperCase();
    if (['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(statusUpper)) {
      where.status = statusUpper;
    }
  }
  /// Negative filter — exclude rows whose status is in the comma-
  /// separated list. Used by admin Booking History to hide cancelled
  /// rows by default so the operational view isn't drowned in dead
  /// retries. The toggle in the UI flips this off when the admin
  /// genuinely wants to see cancellations.
  if (excludeStatus && !where.status) {
    const list = String(excludeStatus)
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) =>
        ['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].includes(s),
      );
    if (list.length > 0) {
      where.status = { notIn: list };
    }
  }
  /// Targeted filters take precedence and AND together — each refines
  /// the result set independently, so typing "51" in bookingId never
  /// matches against phone numbers or other rows the way the legacy
  /// `search` did.
  if (bookingId != null) {
    where.id = Number(bookingId);
  }
  if (customer) {
    where.customer = {
      OR: [
        { name: { contains: customer, mode: 'insensitive' } },
        { phone: { contains: customer, mode: 'insensitive' } },
      ],
    };
  }
  if (partner) {
    where.partner = {
      OR: [
        { name: { contains: partner, mode: 'insensitive' } },
        { phone: { contains: partner, mode: 'insensitive' } },
      ],
    };
  }
  /// Legacy combined search — left in place for backward compatibility
  /// with any caller still passing `search`. Skipped when any of the
  /// targeted filters above are set, since mixing the two would be
  /// surprising and noisy.
  if (search && bookingId == null && !customer && !partner) {
    const or = [
      { customer: { name: { contains: search, mode: 'insensitive' } } },
      { customer: { phone: { contains: search, mode: 'insensitive' } } },
      { partner: { name: { contains: search, mode: 'insensitive' } } },
      { partner: { phone: { contains: search, mode: 'insensitive' } } },
      { items: { some: { serviceName: { contains: search, mode: 'insensitive' } } } },
    ];
    // If the search string is a pure integer, also match by booking id.
    const idMatch = /^\d+$/.test(search) ? Number(search) : null;
    if (idMatch != null) or.push({ id: idMatch });
    where.OR = or;
  }
  if (from) {
    where.createdAt = { ...(where.createdAt ?? {}), gte: new Date(from) };
  }
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    where.createdAt = { ...(where.createdAt ?? {}), lte: toDate };
  }
  if (partnerId) where.partnerId = Number(partnerId);
  /// Apply admin role-based scope last so it always intersects with
  /// the rest of the WHERE clause. Scope is computed in the controller
  /// from `req.user.role` + `req.user.cityIds` and the requested
  /// cityId/stateId filter.
  if (scope) applyScopeToWhere(where, scope);

  const [items, total] = await Promise.all([
    prisma.booking.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: ADMIN_INCLUDE,
    }),
    prisma.booking.count({ where }),
  ]);

  return {
    data: items.map(adminShape),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

exports.liveJobs = async ({ scope } = {}) => {
  const { applyScopeToWhere } = require('../../middlewares/adminScope');
  const where = { status: { in: ['CONFIRMED', 'IN_PROGRESS'] } };
  if (scope) applyScopeToWhere(where, scope);
  const items = await prisma.booking.findMany({
    where,
    orderBy: { scheduledAt: 'asc' },
    include: ADMIN_INCLUDE,
    take: 50,
  });
  /// Pull the real partner name + id from the join. Synthesised
  /// "Partner {id}" labels were left over from before the
  /// partnerId column existed on Booking — now that it does, use
  /// the actual relation. Fall back to "Unassigned" so a stray
  /// CONFIRMED row without a partner still renders something.
  return items.map((b) => {
    const shaped = adminShape(b);
    const minsAgo = Math.floor((Date.now() - new Date(b.updatedAt).getTime()) / 60000);
    return {
      id: b.id,
      partner: shaped.partner ?? 'Unassigned',
      partnerId: b.partnerId != null ? String(b.partnerId) : '',
      customer: shaped.customer,
      customerPhone: shaped.customerPhone,
      service: shaped.service,
      area: shaped.area,
      city: shaped.cityName,
      state: shaped.state,
      stateCode: shaped.stateCode,
      status: b.status === 'IN_PROGRESS' ? 'in_progress' : (minsAgo % 2 === 0 ? 'enroute' : 'arrived'),
      startedAt: new Date(b.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      lastUpdateMinsAgo: Math.max(0, Math.min(20, minsAgo)),
      etaMins: b.status === 'IN_PROGRESS' ? 0 : 5 + (minsAgo % 15),
      amount: b.total,
    };
  });
};

// In-memory disputes store — replace with prisma.dispute model later.
const disputes = [];

exports.listDisputes = async ({ status, search } = {}) => {
  let items = disputes;
  if (status && status !== 'all') items = items.filter((d) => d.status === status);
  if (search) {
    const s = search.toLowerCase();
    items = items.filter(
      (d) => d.id.toLowerCase().includes(s) || d.bookingId.toLowerCase().includes(s) || d.reason.toLowerCase().includes(s),
    );
  }
  return {
    data: items,
    meta: { page: 1, pageSize: items.length, total: items.length, totalPages: 1 },
  };
};

exports.resolveDispute = async (id, resolution, action) => {
  const idx = disputes.findIndex((d) => d.id === id);
  if (idx === -1) throw ApiError.notFound('Dispute not found');
  disputes[idx] = {
    ...disputes[idx],
    status: 'resolved',
    resolution: `${action.toUpperCase()}: ${resolution}`,
    resolvedAt: new Date().toISOString(),
    resolvedBy: 'Admin',
  };
  return disputes[idx];
};

exports.addDisputeNote = async (id, text) => {
  const idx = disputes.findIndex((d) => d.id === id);
  if (idx === -1) throw ApiError.notFound('Dispute not found');
  disputes[idx].notes = [
    ...(disputes[idx].notes ?? []),
    { author: 'Admin', text, createdAt: new Date().toISOString() },
  ];
  return disputes[idx];
};

exports.listStuckJobs = async () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const items = await prisma.booking.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lte: fiveMinAgo },
    },
    orderBy: { createdAt: 'asc' },
    include: ADMIN_INCLUDE,
    take: 30,
  });
  return items.map((b) => {
    const pendingMins = Math.floor((Date.now() - new Date(b.createdAt).getTime()) / 60000);
    const shaped = adminShape(b);
    return {
      id: b.id,
      service: shaped.service,
      customer: shaped.customer,
      area: shaped.area,
      amount: b.total,
      scheduledAt: shaped.scheduledAt,
      pendingMins,
      attemptsCount: Math.min(5, Math.floor(pendingMins / 3)),
    };
  });
};

exports.nearbyPartners = async (_bookingId) => {
  void _bookingId;
  // Verified active partners. Distance is synthesised until partner
  // location tracking is implemented; rating + jobsCompleted are real.
  const partners = await prisma.partner.findMany({
    where: { isActive: true, isVerified: true },
    take: 8,
    orderBy: { createdAt: 'desc' },
  });
  if (partners.length === 0) return [];
  const partnerIds = partners.map((p) => p.id);

  const [completedAgg, ratingAgg, activeAgg] = await Promise.all([
    prisma.booking.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds }, status: 'COMPLETED' },
      _count: { _all: true },
    }),
    prisma.bookingRating.groupBy({
      by: ['partnerId'],
      where: { partnerId: { in: partnerIds } },
      _avg: { stars: true },
      _count: { _all: true },
    }),
    prisma.booking.findMany({
      where: { partnerId: { in: partnerIds }, status: { in: ['CONFIRMED', 'IN_PROGRESS'] } },
      select: { partnerId: true },
    }),
  ]);
  const completedByPartner = new Map(completedAgg.map((r) => [r.partnerId, r._count._all]));
  const ratingByPartner = new Map(
    ratingAgg.map((r) => [r.partnerId, { avg: r._avg.stars ?? 0, count: r._count._all }])
  );
  const busyPartnerIds = new Set(activeAgg.map((b) => b.partnerId));

  return partners.map((p, i) => {
    const r = ratingByPartner.get(p.id);
    return {
      id: p.id,
      name: p.name ?? p.businessName ?? 'Partner',
      phone: p.phone,
      distanceKm: 0.5 + i * 0.7,
      rating: r ? Math.round(r.avg * 10) / 10 : 0,
      ratingCount: r ? r.count : 0,
      jobsCompleted: completedByPartner.get(p.id) ?? 0,
      category: p.businessName ?? 'General',
      status: busyPartnerIds.has(p.id) ? 'busy' : 'available',
    };
  });
};

exports.reassign = async (bookingId, partnerId, reason) => {
  const b = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.status !== 'PENDING' && b.status !== 'CONFIRMED') {
    throw ApiError.badRequest('Only pending or confirmed bookings can be reassigned');
  }
  // No partnerId column on Booking yet — log into notes for audit.
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status: 'CONFIRMED',
      notes: `${b.notes ?? ''}\nManual dispatch → ${partnerId} (${reason})`.trim(),
    },
    include: ADMIN_INCLUDE,
  });
  return adminShape(updated);
};

exports.adminGet = async (id) => {
  const b = await prisma.booking.findUnique({
    where: { id },
    include: ADMIN_INCLUDE,
  });
  if (!b) throw ApiError.notFound('Booking not found');
  return adminShape(b);
};

const appendNote = (current, line) => [current, line].filter(Boolean).join('\n').trim();

exports.reassign = async (bookingId, partnerId, reason = 'Manual assignment') => {
  const b = await prisma.booking.findUnique({ where: { id: Number(bookingId) } });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.status !== 'PENDING' && b.status !== 'CONFIRMED') {
    throw ApiError.badRequest('Only pending or confirmed bookings can be reassigned');
  }

  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: { id: true, name: true, phone: true, businessName: true },
  });
  if (!partner) throw ApiError.notFound('Partner not found');
  const partnerLabel = partner.name ?? partner.businessName ?? `Partner ${partner.id}`;

  const updated = await prisma.booking.update({
    where: { id: Number(bookingId) },
    data: {
      partnerId: partner.id,
      status: 'CONFIRMED',
      /// Clear the dispatch-related fields so the booking falls out of
      /// the Manual Dispatch queue and admin views show the partner
      /// instead of "needs_admin_dispatch".
      dispatchStatus: 'assigned',
      noPartnerReason: null,
      notes: appendNote(b.notes, `Admin assigned ${partnerLabel} (#${partner.id}): ${reason}`),
    },
    include: ADMIN_INCLUDE,
  });

  /// Drop any pending wave/expire/admin_timeout jobs so the
  /// safety-net auto-cancel can't fire after this assignment.
  await dispatcher.cancelAllForBooking(Number(bookingId)).catch(() => {});

  /// Push a job-assigned notification so the partner sees this in
  /// their bell + drawer the moment admin moves the booking onto them.
  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: partner.id,
    type: 'job_request',
    title: 'New job assigned',
    body: `Admin assigned booking #${bookingId} to you. Open it for details.`,
    bookingId: Number(bookingId),
  });

  return adminShape(updated);
};

exports.adminUpdateStatus = async (id, status, note) => {
  const bookingId = Number(id);
  const b = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!b) throw ApiError.notFound('Booking not found');

  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      status,
      notes: note ? appendNote(b.notes, `Admin status ${status}: ${note}`) : b.notes,
    },
    include: ADMIN_INCLUDE,
  });
  return adminShape(updated);
};

exports.adminCancel = async (id, reason) => {
  const bookingId = Number(id);
  const b = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.status === 'COMPLETED') throw ApiError.badRequest('Completed bookings cannot be cancelled');
  /// Don't re-refund a row that's already been cancelled — would
  /// double-decrement `usedCount` if an admin re-cancels for any
  /// reason. Same guard the auto-expirer uses.
  const wasActive = b.status !== 'CANCELLED';

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.booking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        notes: appendNote(b.notes, `Admin cancelled: ${reason}`),
      },
      include: ADMIN_INCLUDE,
    });
    if (wasActive && b.couponId != null) {
      await couponsService.refundForBooking({ couponId: b.couponId, tx });
    }
    return next;
  });

  /// Only kick a refund when the cancel actually happened (wasActive)
  /// — re-cancelling a CANCELLED booking shouldn't double-refund.
  if (wasActive) {
    await tryRefund(bookingId, `Admin cancelled: ${reason}`);
  }

  return adminShape(updated);
};

/// Admin manually records a payment — typically used when the partner
/// collected cash on completion, or when reconciling an out-of-band
/// bank transfer the customer made. Creates a Payment row with
/// status=paid (auditable, dated to NOW), then refreshes the Booking
/// rollup so list pills flip to "Paid". Idempotency guard: refuses
/// if there's already a paid Payment row for the booking — prevents
/// double-counting if the admin clicks the button twice.
exports.adminMarkPaid = async (id, { method = 'cash', amount, note } = {}) => {
  const bookingId = Number(id);
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      total: true,
      offeredPrice: true,
      paymentStatus: true,
      notes: true,
    },
  });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.paymentStatus === 'paid') {
    throw ApiError.badRequest('This booking is already marked as paid.');
  }

  const finalAmount = Number(amount ?? b.offeredPrice ?? b.total);
  if (!Number.isFinite(finalAmount) || finalAmount <= 0) {
    throw ApiError.badRequest('Invalid payment amount.');
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.payment.create({
      data: {
        bookingId: b.id,
        amount: finalAmount,
        currency: 'INR',
        status: 'paid',
        method,
        provider: method,
        paidAt: new Date(),
      },
    });
    /// Inline rollup update — refunds the same logic as
    /// `syncBookingRollup` in razorpay.service.js but kept local so
    /// we don't cross modules. Same end state.
    return tx.booking.update({
      where: { id: b.id },
      data: {
        paymentStatus: 'paid',
        paymentMethod: method,
        paidAt: new Date(),
        notes: appendNote(
          b.notes,
          `Admin marked paid via ${method}: ₹${finalAmount}${note ? ` — ${note}` : ''}`,
        ),
      },
      include: ADMIN_INCLUDE,
    });
  });
  return adminShape(updated);
};

/// Manually retry a refund. Used when the auto-refund (kicked at
/// cancel-time) failed at Razorpay's end — the webhook flips the
/// Payment back to `paid` with a `failureReason`, and the admin
/// needs a way to retry once the customer has updated bank details
/// or whatever else fixed the failure.
///
/// Same guards as the auto-path: only works when the booking is
/// CANCELLED + the latest Payment is `paid` + has a Razorpay
/// providerPaymentId. Anything else (already in refund_pending,
/// already refunded, never paid) gets a clear error so the admin
/// knows why the button did nothing.
exports.adminRetryRefund = async (id) => {
  const bookingId = Number(id);
  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { id: true, status: true, paymentStatus: true },
  });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.status !== 'CANCELLED') {
    throw ApiError.badRequest('Refunds are only issued for cancelled bookings');
  }
  if (b.paymentStatus !== 'paid') {
    throw ApiError.badRequest(
      `Cannot refund a booking with payment status "${b.paymentStatus}"`,
    );
  }
  const result = await razorpayService.refundForBooking({
    bookingId,
    reason: 'Admin retried refund',
  });
  if (!result) {
    throw ApiError.badRequest('No paid Razorpay payment found to refund');
  }
  /// Re-read the booking so the response reflects the updated rollup
  /// (paymentStatus should now read `refund_pending`).
  const updated = await prisma.booking.findUnique({
    where: { id: bookingId },
    include: ADMIN_INCLUDE,
  });
  return adminShape(updated);
};

/// Reschedule a booking — admin can move both the wall-clock time
/// (`scheduledAt`) and the labelled slot (`slotLabel`) for a booking
/// that hasn't started yet. Refuses on COMPLETED / CANCELLED rows
/// (no point) and on IN_PROGRESS (the partner is on-site).
exports.adminReschedule = async (id, { scheduledAt, slotLabel, reason }) => {
  const bookingId = Number(id);
  const b = await prisma.booking.findUnique({ where: { id: bookingId } });
  if (!b) throw ApiError.notFound('Booking not found');
  if (['COMPLETED', 'CANCELLED', 'IN_PROGRESS'].includes(b.status)) {
    throw ApiError.badRequest(
      `Bookings in ${b.status} state cannot be rescheduled.`,
    );
  }
  const next = new Date(scheduledAt);
  if (Number.isNaN(next.getTime())) {
    throw ApiError.badRequest('Invalid scheduledAt timestamp.');
  }

  const previous = b.scheduledAt.toISOString();
  const updated = await prisma.booking.update({
    where: { id: bookingId },
    data: {
      scheduledAt: next,
      slotLabel: slotLabel ?? b.slotLabel,
      notes: appendNote(
        b.notes,
        `Admin rescheduled: ${previous} → ${next.toISOString()}${
          slotLabel ? ` (slot: ${slotLabel})` : ''
        }${reason ? ` — ${reason}` : ''}`,
      ),
    },
    include: ADMIN_INCLUDE,
  });
  return adminShape(updated);
};

// ── Partner booking actions ──────────────────────────────────────────────────

exports.partnerIncoming = async ({ partnerId, lat, lng }) => {
  /// LEGACY-only — when the BullMQ dispatcher is enabled, expiry is
  /// driven by scheduled jobs and we don't need to sweep on every poll.
  /// Without Redis, the lazy expirer is still our only chance to flip
  /// stale rows to CANCELLED, so we keep it as a fallback.
  if (!dispatchQueue.enabled()) {
    await expireBroadcasts();
  }

  if (await partnerHasActiveJob(partnerId)) return [];

  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: { categoryId: true, isActive: true, isVerified: true },
  });
  if (!partner?.isActive || !partner?.isVerified || !partner.categoryId) return [];

  const coords = lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
  if (!coords) return [];

  /// Push-mode side-effect: every poll counts as a presence ping. So
  /// even if the partner-app hasn't been converted to Socket.io yet,
  /// the dispatcher's GEOSEARCH still finds them. Refreshes the
  /// last-seen TTL on each call.
  if (dispatchRegistry.enabled()) {
    await dispatchRegistry.upsertOnline({
      partnerId: Number(partnerId),
      categoryId: partner.categoryId,
      lat: coords.lat,
      lng: coords.lng,
    });
  }

  const now = new Date();

  /// PUSH PATH — the BullMQ dispatcher has been writing the visibleTo
  /// set as it fires waves. We hydrate the booking ids the partner has
  /// been offered and serve them, dropping any that have moved out of
  /// PENDING since they were offered.
  if (dispatchQueue.enabled()) {
    const offeredIds = await dispatchRegistry.listOffersForPartner(partnerId);
    if (offeredIds.length === 0) return [];

    const bookings = await prisma.booking.findMany({
      where: {
        id: { in: offeredIds },
        status: 'PENDING',
        partnerId: null,
        /// Only show bookings that are CURRENTLY broadcasting. After
        /// the 30s wave window, dispatchStatus flips to
        /// `needs_admin_dispatch` (or `payment_timeout` / `superseded`
        /// for other cancel paths) — in those states the partner
        /// shouldn't see the alert. Without this filter, a stale
        /// entry in their offers set re-surfaces the JobAlert every
        /// 5s and Accept fails with "not in broadcast window".
        dispatchStatus: { in: ['waiting', 'broadcasting'] },
        items: { some: { service: { categoryId: partner.categoryId } } },
      },
      include: PARTNER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    const commissionMap = await loadCommissionMap();
    return bookings
      .filter((b) => b.lat != null && b.lng != null)
      .map((b) => partnerShape(b, coords, commissionMap))
      .sort((a, z) => a.distanceKm - z.distanceKm);
  }

  /// LEGACY PULL PATH — DB scan + JS-side haversine. Used when Redis
  /// isn't configured. Same logic as before; kept for dev environments
  /// without Redis and for emergency rollback.
  const where = {
    status: 'PENDING',
    partnerId: null,
    dispatchStatus: { in: ['waiting', 'broadcasting'] },
    items: { some: { service: { categoryId: partner.categoryId } } },
    OR: [
      { isInstant: true },
      { offeredPrice: { not: null } },
      { scheduledAt: { lte: new Date(now.getTime() + SCHEDULE_DISPATCH_LEAD_MS) } },
    ],
  };

  const bookings = await prisma.booking.findMany({
    where,
    include: PARTNER_INCLUDE,
    orderBy: { createdAt: 'asc' },
    take: 50,
  });

  const visible = [];
  const waveUpdates = [];
  for (const b of bookings) {
    const wave = dispatchWindowFor(b, now);
    if (!wave) continue;
    if (b.lat == null || b.lng == null) continue;

    const distanceKm = haversineKm(coords, { lat: b.lat, lng: b.lng });
    if (distanceKm > wave.radiusKm) continue;

    visible.push(b);
    if (b.dispatchWave !== wave.wave || b.dispatchRadiusKm !== wave.radiusKm || b.dispatchStatus !== 'broadcasting') {
      waveUpdates.push(
        prisma.booking.updateMany({
          where: { id: b.id, status: 'PENDING', partnerId: null },
          data: {
            dispatchStatus: 'broadcasting',
            dispatchStartedAt: broadcastStartFor(b),
            dispatchExpiresAt: new Date(broadcastStartFor(b).getTime() + DISPATCH_TOTAL_MS),
            dispatchRadiusKm: wave.radiusKm,
            dispatchWave: wave.wave,
          },
        }),
      );
    }
  }

  if (waveUpdates.length > 0) await Promise.all(waveUpdates);

  const commissionMap = await loadCommissionMap();
  return visible
    .map((b) => partnerShape(b, coords, commissionMap))
    .sort((a, z) => a.distanceKm - z.distanceKm);
};

exports.partnerAccept = async ({ bookingId, partnerId }) => {
  /// Legacy fallback only; the BullMQ expirer handles this path when
  /// the queue is enabled.
  if (!dispatchQueue.enabled()) {
    await expireBroadcasts();
  }

  if (await partnerHasActiveJob(partnerId)) {
    throw ApiError.conflict('Finish your active job before accepting another booking');
  }

  const id = Number(bookingId);

  /// Fast-fail Redis claim — first partner to call wins the lock.
  /// Subsequent calls find the lock taken and we 409 out before the
  /// (more expensive) DB transaction runs. Falls open when Redis is
  /// down: tryClaim returns true so the DB-side guard is the only
  /// gate, which is how the legacy path has always worked.
  const claimed = await dispatchRegistry.tryClaim({ bookingId: id, partnerId });
  if (!claimed) {
    throw ApiError.conflict('Booking already accepted by another partner');
  }

  const b = await prisma.booking.findUnique({
    where: { id },
    include: {
      items: { include: { service: { select: { categoryId: true } } } },
    },
  });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.status !== 'PENDING') throw ApiError.conflict('Booking is no longer available');
  if (b.partnerId !== null) throw ApiError.conflict('Booking already accepted by another partner');
  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: { categoryId: true, isActive: true, isVerified: true },
  });
  if (!partner?.isActive || !partner?.isVerified) throw ApiError.forbidden('Partner is not active');
  const categoryMatches = b.items.some((i) => i.service?.categoryId === partner.categoryId);
  if (!categoryMatches) throw ApiError.forbidden('Booking category does not match your profile');
  /// Previously we required the booking to be inside the formal
  /// broadcast window (`dispatchWindowFor` returns a wave only while
  /// elapsed < DISPATCH_TOTAL_MS). With 10s waves that's only ~30s
  /// end-to-end — a partner who saw the alert at second 28 and tapped
  /// Accept at second 31 was getting "not currently in broadcast
  /// window" with no recourse.
  ///
  /// Acceptance is fine as long as the booking is still assignable:
  /// PENDING + partnerId null + dispatchStatus in a non-terminal
  /// state. Letting a partner grab a `needs_admin_dispatch` booking
  /// also relieves admin work — manual dispatch is just a fallback,
  /// not a rule. The DB updateMany below is still the race-safe
  /// final word.
  const acceptableDispatchStates = new Set([
    'waiting',
    'broadcasting',
    'needs_admin_dispatch',
  ]);
  if (!acceptableDispatchStates.has(b.dispatchStatus)) {
    throw ApiError.conflict('This booking is no longer available');
  }

  /// DB-side guard — even with the Redis lock, we use updateMany with
  /// (status PENDING + partnerId null) so two near-simultaneous
  /// accepts can never both transition the row.
  ///
  /// BYOP (`offeredPrice` set) starts a 3-minute pay-after-accept
  /// window. The customer-app shows a countdown; if payment doesn't
  /// land before paymentDeadlineAt, a queued worker auto-cancels.
  /// Non-BYOP bookings already pre-paid, so we don't set a deadline
  /// for them.
  const isByop = b.offeredPrice != null;
  const paymentDeadlineAt = isByop
    ? new Date(Date.now() + BYOP_PAYMENT_HOLD_MS)
    : null;

  const result = await prisma.booking.updateMany({
    where: { id, status: 'PENDING', partnerId: null },
    data: {
      partnerId,
      status: 'CONFIRMED',
      dispatchStatus: 'accepted',
      paymentDeadlineAt,
    },
  });
  if (result.count === 0) {
    /// Lost the race at the DB layer despite winning the Redis claim
    /// — possible if Redis was momentarily unreachable. Release the
    /// lock so subsequent attempts have a clean slate.
    await dispatchRegistry.clearBooking(id);
    throw ApiError.conflict('Booking already accepted by another partner');
  }

  /// Cancel the queued wave + expiry jobs and clear Redis state — no
  /// need to fan out further or expire something that's now in flight.
  /// Also pull the partner from the online geo-set so subsequent waves
  /// for OTHER bookings don't keep offering jobs to someone who's now
  /// busy. They'll be re-added on their next presence ping after the
  /// job completes.
  ///
  /// For BYOP bookings, also enqueue a delayed `payment_expire` job
  /// that auto-cancels the booking if the customer hasn't paid by
  /// `paymentDeadlineAt`. Idempotent jobId so a retry-accept doesn't
  /// double-schedule.
  if (dispatchQueue.enabled()) {
    /// Snapshot the audience BEFORE cancel/clear wipes the visibleTo
    /// set — we use it to broadcast the targeted dispatch.claimed
    /// event to the ~50 partners who saw this offer (instead of the
    /// 2000+ who didn't).
    const audience = await dispatchRegistry.listPartnersForBooking(id).catch(() => []);
    await dispatcher.cancelAllForBooking(id).catch(() => {});
    if (isByop) {
      await dispatcher.schedulePaymentExpire(id, BYOP_PAYMENT_HOLD_MS).catch(() => {});
    }
    if (partner.categoryId != null) {
      await dispatchRegistry.removeOnline({ partnerId, categoryId: partner.categoryId }).catch(() => {});
    }
    dispatcher.broadcastClaimed(audience, { bookingId: id, partnerId });
  }

  const updated = await prisma.booking.findUnique({
    where: { id },
    include: PARTNER_INCLUDE,
  });
  const commissionMap = await loadCommissionMap();
  return partnerShape(updated, null, commissionMap);
};

exports.partnerMine = async ({ partnerId, bucket }) => {
  const where = { partnerId };
  if (bucket === 'active') where.status = { in: ['CONFIRMED', 'IN_PROGRESS'] };
  else if (bucket === 'history') {
    /// History = jobs the partner actually owned. Hide system-driven
    /// cancellations (no-pay timeout, etc.) so the partner doesn't see
    /// "you accepted but customer ghosted" rows piling up — those
    /// weren't the partner's fault and shouldn't count against their
    /// completion rate. Same signal as customer-side listMine:
    /// `noPartnerReason` non-null = system cancel.
    where.OR = [
      { status: 'COMPLETED' },
      { status: 'CANCELLED', noPartnerReason: null },
    ];
  }

  const bookings = await prisma.booking.findMany({
    where,
    include: PARTNER_INCLUDE,
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  const commissionMap = await loadCommissionMap();
  return bookings.map((b) => partnerShape(b, null, commissionMap));
};

// 'enroute' and 'arrived' are purely client-side states (no separate DB enum).
// Only in_progress and completed require a backend status update.
const PARTNER_DB_STATUS = {
  in_progress: 'IN_PROGRESS',
  completed: 'COMPLETED',
};

exports.partnerUpdateStatus = async ({ bookingId, partnerId, status, otp }) => {
  const id = Number(bookingId);
  const b = await prisma.booking.findUnique({
    where: { id },
    select: {
      id: true,
      partnerId: true,
      status: true,
      jobStartOtp: true,
      jobCompleteOtp: true,
    },
  });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.partnerId !== partnerId) throw ApiError.forbidden('Not your booking');

  const dbStatus = PARTNER_DB_STATUS[status];
  if (!dbStatus) throw ApiError.badRequest(`Status '${status}' cannot be synced to backend`);

  /// OTP gate. Legacy bookings created before the OTP migration have a
  /// null code — we let those through so partners can finish in-flight
  /// jobs. New bookings always have both codes, so this only no-ops for
  /// the small backlog created pre-2026-05-06.
  const data = { status: dbStatus };
  if (status === 'in_progress') {
    if (b.jobStartOtp) {
      if (!otp || String(otp).trim() !== b.jobStartOtp) {
        throw ApiError.badRequest('Invalid start OTP. Ask the customer to share the 4-digit code.');
      }
    }
    data.jobStartedAt = new Date();
  } else if (status === 'completed') {
    if (b.jobCompleteOtp) {
      if (!otp || String(otp).trim() !== b.jobCompleteOtp) {
        throw ApiError.badRequest('Invalid completion OTP. Ask the customer to share the 4-digit code.');
      }
    }
    data.jobCompletedAt = new Date();
  }

  const updated = await prisma.booking.update({
    where: { id },
    data,
    include: PARTNER_INCLUDE,
  });

  /// Credit the partner the moment the job flips to COMPLETED. The
  /// earnings service is idempotent — a duplicate completion event
  /// (network retry, admin re-mark) returns the same row instead of
  /// double-paying the partner. Errors here are logged but don't
  /// roll back the status update; the admin tool can later re-trigger
  /// crediting if a transient failure stranded a row.
  if (status === 'completed') {
    try {
      await earningsService.creditForBooking(id);
    } catch (err) {
      console.warn(`Earning credit failed for booking ${id}: ${err.message}`);
    }
  }

  const commissionMap = await loadCommissionMap();
  return partnerShape(updated, null, commissionMap);
};
