const crypto = require('crypto');
const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const couponsService = require('../coupons/coupons.service');
const dispatcher = require('../dispatch/dispatcher');
const dispatchQueue = require('../dispatch/queue');
const dispatchRegistry = require('../dispatch/registry');
const earningsService = require('../payments/earnings.service');
const razorpayService = require('../payments/razorpay.service');
const policyService = require('../policy/policy.service');
const cityResolver = require('../geography/city-resolver');
const { computeFare } = require('../../utils/fare');

/// Best-effort refund kick — called from every CANCELLED transition.
/// Wrapped so a Razorpay outage / config gap can't roll back a cancel
/// that has already committed to the DB. The webhook reconciliation
/// path (`handleRefundWebhook`) will eventually catch up if the call
/// failed; the admin can also manually re-trigger via an admin tool
/// added later.
const tryRefund = async (bookingId, reason, refundAmount = null) => {
  try {
    return await razorpayService.refundForBooking({ bookingId, reason, refundAmount });
  } catch (err) {
    console.warn(`Refund kick failed for booking ${bookingId}: ${err.message}`);
    return null;
  }
};

/// 4-digit handoff code, never starts with 0 so it stays a four-character
/// string when the customer reads it out and the partner types it.
const generateOtp = () => String(1000 + crypto.randomInt(0, 9000));

/// "DDMMYY" date component of the human-facing Booking ID, in
/// Asia/Kolkata so the date a customer sees on their ref matches the
/// IST business day regardless of where the server runs. `en-GB`
/// yields day/month/year order; we strip the slashes to get DDMMYY.
const istDayKey = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}${get('month')}${get('year')}`;
};

/// Generate the next collision-free Booking ID inside the create
/// transaction. Atomically bumps the per-day counter (UPSERT … seq =
/// seq + 1) so two concurrent bookings on the same day can never read
/// the same number — Postgres serialises the conflicting row update.
/// Pads to 3 digits for the common case (001) but naturally grows to
/// 4+ digits past 999/day, so a high-volume day never breaks. MUST be
/// called with the same `tx` as the booking insert so a rolled-back
/// booking doesn't strand a consumed sequence number.
const generateBookingRef = async (tx, now = new Date()) => {
  const day = istDayKey(now);
  const counter = await tx.bookingRefCounter.upsert({
    where: { day },
    create: { day, seq: 1 },
    update: { seq: { increment: 1 } },
    select: { seq: true },
  });
  return `DHND${day}${String(counter.seq).padStart(3, '0')}`;
};

const findServiceAreaForAddress = async ({ city, pincode, cityId }) => {
  const pin = String(pincode ?? '').trim();
  if (pin) {
    const pinMatch = await prisma.serviceArea.findFirst({
      where: { pincodes: { has: pin }, active: true },
      select: { id: true, city: true, pincodes: true, categoryIds: true },
    });
    if (pinMatch) return pinMatch;
  }

  if (cityId) {
    const cityMatch = await prisma.serviceArea.findFirst({
      where: { cityId, active: true },
      select: { id: true, city: true, pincodes: true, categoryIds: true },
    });
    if (cityMatch) return cityMatch;
  }

  const cityKey = String(city ?? '').trim();
  if (!cityKey) return null;
  return prisma.serviceArea.findFirst({
    where: { city: { equals: cityKey, mode: 'insensitive' }, active: true },
    select: { id: true, city: true, pincodes: true, categoryIds: true },
  });
};

const assertServicesAllowedInArea = async ({ services, city, pincode, cityId }) => {
  const area = await findServiceAreaForAddress({ city, pincode, cityId });
  if (!area) {
    throw ApiError.badRequest('Dhoond is not live at this address yet.');
  }

  const pin = String(pincode ?? '').trim();
  if (area.pincodes.length > 0 && (!pin || !area.pincodes.includes(pin))) {
    throw ApiError.badRequest(`We're live in ${area.city} but not at this pincode yet.`);
  }

  if (area.categoryIds.length === 0) return;

  const allowed = new Set(area.categoryIds.map(Number));
  const blocked = services.filter((s) => !allowed.has(Number(s.categoryId)));
  if (blocked.length > 0) {
    throw ApiError.badRequest(
      `This service is not available in ${area.city} yet: ${blocked.map((s) => s.name).join(', ')}`,
    );
  }
};

/// BYOP pay-after-accept window. When a partner accepts a booking
/// with `offeredPrice`, the customer has this long to pay before the
/// booking auto-cancels. 3 minutes balances "long enough to open
/// Razorpay and complete the flow on a slow network" against "short
/// enough that a partner isn't held in limbo while the customer
/// disappears". Tune via env if needed.
const BYOP_PAYMENT_HOLD_MS = 3 * 60 * 1000;
const INSTANT_PAYMENT_HOLD_MS = 3 * 60 * 1000;

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
/// they encode the same 30s attempt + 2s gap cadence so a dev env
/// without Redis behaves the same as the production push path.
const DISPATCH_WINDOW_MS = 30 * 1000;
const DISPATCH_RETRY_GAP_MS = 2 * 1000;
const DISPATCH_STEP_MS = DISPATCH_WINDOW_MS + DISPATCH_RETRY_GAP_MS;
const DISPATCH_WAVES = [
  { wave: 1, radiusKm: 3, startsAtMs: 0, endsAtMs: DISPATCH_WINDOW_MS },
  {
    wave: 2,
    radiusKm: 3,
    startsAtMs: DISPATCH_STEP_MS,
    endsAtMs: DISPATCH_STEP_MS + DISPATCH_WINDOW_MS,
  },
  {
    wave: 3,
    radiusKm: 5,
    startsAtMs: DISPATCH_STEP_MS * 2,
    endsAtMs: DISPATCH_STEP_MS * 2 + DISPATCH_WINDOW_MS,
  },
  {
    wave: 4,
    radiusKm: 5,
    startsAtMs: DISPATCH_STEP_MS * 3,
    endsAtMs: DISPATCH_STEP_MS * 3 + DISPATCH_WINDOW_MS,
  },
  {
    wave: 5,
    radiusKm: 7,
    startsAtMs: DISPATCH_STEP_MS * 4,
    endsAtMs: DISPATCH_STEP_MS * 4 + DISPATCH_WINDOW_MS,
  },
  {
    wave: 6,
    radiusKm: 7,
    startsAtMs: DISPATCH_STEP_MS * 5,
    endsAtMs: DISPATCH_STEP_MS * 5 + DISPATCH_WINDOW_MS,
  },
];
const FINAL_DISPATCH_WAVE = DISPATCH_WAVES[DISPATCH_WAVES.length - 1];
const DISPATCH_TOTAL_MS = FINAL_DISPATCH_WAVE.endsAtMs;
// Lead time before a scheduled slot at which dispatch begins. MUST stay
// in sync with the same constant in dispatch/dispatcher.js.
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
  return DISPATCH_WAVES.find((w) => elapsedMs >= w.startsAtMs && elapsedMs < w.endsAtMs) ?? null;
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
          dispatchRadiusKm: FINAL_DISPATCH_WAVE.radiusKm,
          dispatchWave: FINAL_DISPATCH_WAVE.wave,
          noPartnerReason: 'No partner accepted within 3km, 5km, or 7km broadcast and retry windows.',
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
        reason: 'No partner found within broadcast and retry windows',
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

  /// PRIVACY GATE — withhold the customer's phone + EXACT location from
  /// the partner until the booking is PAID. This covers the BYOP /
  /// instant "pay-after-accept" flow: a partner accepts, the customer
  /// has a short window to pay, and until that payment lands the partner
  /// must NOT be able to call the customer or navigate to their exact
  /// door. We still expose the general area (city) so the partner can
  /// gauge the job, just not the precise address / coordinates / phone.
  /// Applies only to in-flight accepted jobs (CONFIRMED / IN_PROGRESS);
  /// COMPLETED jobs keep full detail for support/history, and incoming
  /// offers already only carry distance (handled by the caller).
  const isAcceptedUnpaid =
    (b.status === 'CONFIRMED' || b.status === 'IN_PROGRESS') &&
    (b.paymentStatus ?? 'unpaid') !== 'paid';
  /// Cash jobs are "pay on completion" — there's no upfront payment to
  /// gate on, so don't mask those (paymentMethod 'cash'). Only the
  /// online pay-first flow is gated.
  const maskContact = isAcceptedUnpaid && b.paymentMethod !== 'cash';

  return {
    id: String(b.id),
    /// Human-facing Booking ID shared across customer/partner/admin.
    bookingRef: b.bookingRef ?? `#${b.id}`,
    service: b.items?.[0]?.serviceName ?? 'Service',
    services,
    customerName: b.customer?.name ?? 'Customer',
    /// Hidden until paid (see maskContact). The app shows "Available
    /// after payment" in place of the number.
    customerPhone: maskContact ? '' : (b.customer?.phone ?? ''),
    /// While unpaid, expose only the city — not the full street line.
    address: maskContact
      ? (addr.city ?? '')
      : [addr.line, addr.city].filter(Boolean).join(', '),
    /// Exact coordinates withheld until paid so the partner can't
    /// navigate to the door before payment.
    lat: maskContact ? null : bookingLat,
    lng: maskContact ? null : bookingLng,
    /// Flag the app uses to render the "unlocks after payment" state on
    /// the contact + navigation controls.
    contactLockedUntilPaid: maskContact,
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
    arrivedAt: b.arrivedAt ?? null,
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
  /// Minimal payment join so the customer shape can surface the ACTUAL
  /// refunded amount on a cancelled booking (full grandTotal minus the
  /// cancellation fee), rather than assuming the whole bill was returned.
  payments: {
    select: { id: true, status: true, amount: true, refundAmount: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  },
  /// Assigned professional — surfaced on the customer's booking-detail
  /// "your professional" card. The aggregate rating is denormalised on the
  /// partner row; the completed-jobs count + trade name are resolved in
  /// `getOwn` (kept off the list path to avoid an N+1).
  partner: {
    select: {
      id: true,
      name: true,
      avgRating: true,
      ratingCount: true,
      categoryId: true,
      /// Profile photo lives on the partner's verification document (the
      /// selfie), not the partner row itself.
      document: { select: { selfieUrl: true } },
    },
  },
};

/// The refund a customer will actually receive on a CANCELLED booking.
/// Reads the latest payment that entered a refund state; returns null
/// when nothing was captured (unpaid cancel) so the UI can hide the
/// refund row instead of promising ₹0 back.
const resolveRefund = (b) => {
  if (b.status !== 'CANCELLED') return null;
  const p = (b.payments ?? []).find(
    (x) => x.refundAmount != null && ['refund_pending', 'refunded'].includes(x.status),
  );
  return p ? p.refundAmount : null;
};

const shape = (b) => {
  const addr = resolveBookingAddress(b);
  const refundAmount = resolveRefund(b);
  const amountPaid = b.grandTotal && b.grandTotal > 0 ? b.grandTotal : b.total;
  return {
  id: b.id,
  /// Human-facing Booking ID (DHND…). Falls back to "#<id>" only for
  /// legacy rows that somehow lack a ref, so the UI always has a label.
  bookingRef: b.bookingRef ?? `#${b.id}`,
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
  /// Cancellation outcome. `refundAmount` is what's actually being
  /// returned (null when nothing was captured); `cancellationFee` is
  /// the rupees retained per the policy tiers. Both null on
  /// non-cancelled bookings so the app only renders them when relevant.
  refundAmount: refundAmount,
  cancellationFee:
    refundAmount != null && amountPaid != null ? Math.max(0, amountPaid - refundAmount) : null,
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
  arrivedAt: b.arrivedAt ?? null,
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
  /// Assigned professional card. Present once a partner has accepted the
  /// booking; `role` (trade name) and `jobsCompleted` are enriched in
  /// `getOwn` (undefined on the list path, where the card isn't shown).
  partner: b.partner
    ? {
        id: b.partner.id,
        name: b.partner.name ?? 'Professional',
        photoUrl: b.partner.document?.selfieUrl ?? null,
        role: b.partner.categoryName ?? null,
        rating: b.partner.avgRating ?? 0,
        ratingCount: b.partner.ratingCount ?? 0,
        jobsCompleted: b.partner.jobsCompleted ?? 0,
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

  await assertServicesAllowedInArea({
    services,
    city: saved?.city ?? inlineAddress?.city,
    pincode: saved?.pincode ?? inlineAddress?.pincode,
    cityId: bookingCityId,
  });

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
      /// Refund any coupon redemptions on the deleted rows so the
      /// customer's promo isn't burned by a back-and-retry loop.
      for (const prev of stalePrev) {
        if (prev.couponId != null) {
          await couponsService.refundForBooking({ couponId: prev.couponId, tx });
        }
      }
      await tx.booking.deleteMany({
        where: {
          id: { in: stalePrev.map((b) => b.id) },
          status: 'PENDING',
          partnerId: null,
          paymentStatus: { not: 'paid' },
        },
      });
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

    /// Reserve the human-facing Booking ID in the same txn so the
    /// sequence is only consumed if the booking actually commits.
    const bookingRef = await generateBookingRef(tx);

    return tx.booking.create({
      data: {
        customerId,
        bookingRef,
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
  if (dispatchQueue.enabled() && booking.isInstant && booking.offeredPrice == null) {
    try {
      await dispatcher.schedulePaymentExpire(booking.id, INSTANT_PAYMENT_HOLD_MS);
    } catch (err) {
      console.warn(`Payment-expire enqueue failed for booking ${booking.id}: ${err.message}`);
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
      title: `New booking ${booking.bookingRef ?? `#${booking.id}`}`,
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
    /// Past = completed jobs + cancellations of REAL bookings the
    /// customer actually placed.
    ///
    /// What we DON'T surface:
    ///   1. System-driven cancellations (no-pay timeout, fresh-attempt
    ///      supersede, no-partner-accepted broadcast expiry) — those
    ///      populate `noPartnerReason`.
    ///   2. Abandoned instant-search attempts — when a customer starts an
    ///      instant booking and backs out of the searching screen before
    ///      any partner accepts or any payment, the app cancels it
    ///      ("Customer left the search"). These never became a real
    ///      booking: NO partner was ever assigned AND it was never paid.
    ///      Previously they passed the filter (customer-cancel path →
    ///      `noPartnerReason` null) and FLOODED Past with junk. We now
    ///      require a cancelled booking to have had a partner assigned OR
    ///      a payment (paid / refund in flight) to count as "real".
    ///
    /// The rows stay in the DB for audit / support / fraud detection —
    /// we just stop surfacing the noise to the customer.
    delete where.status;
    where.OR = [
      { status: 'COMPLETED' },
      {
        status: 'CANCELLED',
        noPartnerReason: null,
        /// Real booking: a partner was assigned at some point, OR the
        /// customer paid (paid / refund_pending / refunded).
        OR: [
          { partnerId: { not: null } },
          { paymentStatus: { in: ['paid', 'refund_pending', 'refunded'] } },
        ],
      },
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
  /// Enrich the assigned partner for the "your professional" card: their
  /// lifetime completed-jobs count and trade name. Done here (single
  /// booking) rather than in `shape`/`BOOKING_INCLUDE` so the bookings-list
  /// path stays a single query.
  if (b.partner) {
    const [jobsCompleted, category] = await Promise.all([
      prisma.booking.count({ where: { partnerId: b.partner.id, status: 'COMPLETED' } }),
      b.partner.categoryId
        ? prisma.category.findUnique({
            where: { id: b.partner.categoryId },
            select: { name: true },
          })
        : Promise.resolve(null),
    ]);
    b.partner.jobsCompleted = jobsCompleted;
    b.partner.categoryName = category?.name ?? null;
  }
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

/// Compute the cancellation fee for a booking the customer is about to
/// cancel. The fee only applies to a captured payment (paymentStatus
/// `paid`) — an unpaid booking has nothing to charge against, so the
/// fee is zero and the refund is a no-op. Shared by `cancelOwn` and the
/// customer-app preview endpoint (`cancellationQuote`) so the quote the
/// customer sees and the amount actually withheld can never diverge.
const quoteCancellation = async (b) => {
  const amountPaid = b.grandTotal && b.grandTotal > 0 ? b.grandTotal : b.total;
  const chargeable = b.paymentStatus === 'paid' && amountPaid > 0;
  if (!chargeable) {
    return {
      chargeable: false,
      amountPaid: chargeable ? amountPaid : 0,
      feePercent: 0,
      feeAmount: 0,
      refundAmount: 0,
      withinFreeWindow: true,
      freeWindowMins: 0,
      elapsedMins: 0,
    };
  }
  const policy = await policyService.getCancellation();
  const fee = policyService.computeCustomerCancelFee({
    policy,
    amountPaid,
    bookedAt: b.createdAt,
  });
  return { chargeable: true, amountPaid, ...fee };
};

/// Read-only preview for the customer-app cancel sheet: "you'll be
/// charged ₹X, ₹Y refunded". Validates ownership + cancellable state so
/// the app surfaces the same errors the real cancel would.
exports.cancellationQuote = async ({ customerId, id }) => {
  const b = await prisma.booking.findUnique({
    where: { id: Number(id) },
    select: {
      customerId: true, status: true, grandTotal: true, total: true,
      createdAt: true, paymentStatus: true,
    },
  });
  if (!b || b.customerId !== customerId) throw ApiError.notFound('Booking not found');
  if (!['PENDING', 'CONFIRMED'].includes(b.status)) {
    throw ApiError.badRequest('Only pending or confirmed bookings can be cancelled.');
  }
  return quoteCancellation(b);
};

exports.cancelOwn = async ({ customerId, id, reason }) => {
  const b = await prisma.booking.findUnique({
    where: { id },
    select: {
      customerId: true, status: true, couponId: true, partnerId: true,
      grandTotal: true, total: true, createdAt: true, paymentStatus: true,
    },
  });
  if (!b || b.customerId !== customerId) throw ApiError.notFound('Booking not found');
  if (!['PENDING', 'CONFIRMED'].includes(b.status)) {
    throw ApiError.badRequest('Only pending or confirmed bookings can be cancelled.');
  }

  /// Resolve the fee BEFORE the cancel commits so we know how much to
  /// refund and can record it on the booking note for the audit trail.
  const quote = await quoteCancellation(b);
  const baseNote = reason ? `Customer cancelled: ${reason}` : 'Customer cancelled';
  const note =
    quote.feeAmount > 0
      ? `${baseNote} · Cancellation fee ₹${quote.feeAmount} (${quote.feePercent}% of ₹${quote.amountPaid}) · Refund ₹${quote.refundAmount}`
      : baseNote;

  /// Wrap the cancel + coupon refund together — same reasoning as
  /// expireBroadcasts. A customer cancelling before the job runs
  /// hasn't consumed the promo, so `usedCount` should fall back.
  await prisma.$transaction(async (tx) => {
    await tx.booking.update({
      where: { id },
      data: { status: 'CANCELLED', notes: note },
    });
    if (b.couponId != null) {
      await couponsService.refundForBooking({ couponId: b.couponId, tx });
    }
  });

  /// Outside the transaction so a Razorpay outage doesn't undo the
  /// cancel itself. `refundAmount` keeps the cancellation fee (refund =
  /// paid − fee); when the booking is unpaid `chargeable` is false and
  /// we pass null so refundForBooking takes its safe no-op path.
  await tryRefund(id, reason ?? 'Customer cancelled', quote.chargeable ? quote.refundAmount : null);

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
    /// Free the partner — their job was cancelled out from under them,
    /// so clear the BUSY flag and let them receive new offers again.
    await dispatchRegistry.clearActiveJob(b.partnerId).catch(() => {});
    require('../tracking/tracking.service').setBusyState({ partnerId: b.partnerId, busy: false });
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

  /// Re-read after the refund kick so the returned booking reflects the
  /// post-refund payment rollup (paymentStatus → refund_pending) and the
  /// actual `refundAmount` the customer shape now surfaces.
  const updated = await prisma.booking.findUnique({ where: { id }, include: BOOKING_INCLUDE });
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
      refundAmount: true,
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
    /// Human-facing Booking ID (DHND…) shown across the admin panel,
    /// manual dispatch, and booking details.
    bookingRef: b.bookingRef ?? `#${b.id}`,
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
    assignedAt: b.assignedAt ?? null,
    arrivedAt: b.arrivedAt ?? null,
    jobStartedAt: b.jobStartedAt ?? null,
    jobCompletedAt: b.jobCompletedAt ?? null,
    /// Job-handoff OTPs surfaced to ADMIN for support — when a customer
    /// can't find the code, the admin reads it back to them so the
    /// partner can start/complete the job. `jobStartedAt`/`jobCompletedAt`
    /// above let the UI grey out a code once that step is already done.
    jobStartOtp: b.jobStartOtp ?? null,
    jobCompleteOtp: b.jobCompleteOtp ?? null,
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
      /// Actual rupees being refunded (bill minus cancellation fee).
      /// Null on non-refund rows. The admin UI shows THIS for a refund
      /// row instead of the original `amount`.
      refundAmount: p.refundAmount ?? null,
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
  bookingType,
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
  /// Booking-type filter — matches the Instant / Scheduled / Book-at-price
  /// badge in the admin table. BYOP is the `offeredPrice != null` signal
  /// and takes precedence (a BYOP booking is ALSO isInstant), so:
  ///   byop      → offeredPrice set (customer named their price)
  ///   instant   → isInstant true AND no offeredPrice (fixed-price now)
  ///   scheduled → not instant (future slot)
  if (bookingType) {
    const t = String(bookingType).toLowerCase();
    if (t === 'byop') {
      where.offeredPrice = { not: null };
    } else if (t === 'instant') {
      where.isInstant = true;
      where.offeredPrice = null;
    } else if (t === 'scheduled') {
      where.isInstant = false;
    }
  }

  /// Targeted filters take precedence and AND together — each refines
  /// the result set independently, so typing "51" in bookingId never
  /// matches against phone numbers or other rows the way the legacy
  /// `search` did.
  if (bookingId != null) {
    /// The Booking ID filter accepts either the human-facing ref
    /// (DHND290526001 — typed in full or partially) or the raw
    /// internal numeric id. A pure-digit input still matches by id so
    /// existing deep links / internal references keep working; any
    /// non-numeric input is matched (case-insensitive, substring)
    /// against `bookingRef`.
    const raw = String(bookingId).trim();
    if (/^\d+$/.test(raw)) {
      where.id = Number(raw);
    } else {
      where.bookingRef = { contains: raw, mode: 'insensitive' };
    }
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
      { bookingRef: { contains: search, mode: 'insensitive' } },
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
    return {
      id: b.id,
      bookingRef: shaped.bookingRef,
      partner: shaped.partner ?? 'Unassigned',
      partnerId: b.partnerId != null ? String(b.partnerId) : '',
      customer: shaped.customer,
      customerPhone: shaped.customerPhone,
      service: shaped.service,
      area: shaped.area,
      city: shaped.cityName,
      state: shaped.state,
      stateCode: shaped.stateCode,
      /// REAL status only — CONFIRMED partners are en route, IN_PROGRESS
      /// are working. We no longer fabricate an "arrived" state or an
      /// ETA from minute parity (there's no live partner-location ETA
      /// source yet; surfacing a made-up number was misleading).
      status: b.status === 'IN_PROGRESS' ? 'in_progress' : 'enroute',
      isInstant: b.isInstant ?? false,
      /// Raw timestamps — the admin UI computes "X ago" live between the
      /// 5s refreshes and formats the scheduled/booked dates itself, so
      /// the values can't go stale or clamp the way the old server-side
      /// `lastUpdateMinsAgo` did (it was capped at 20).
      updatedAt: b.updatedAt,
      createdAt: b.createdAt,
      scheduledAt: b.scheduledAt,
      jobStartedAt: b.jobStartedAt ?? null,
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

exports.nearbyPartners = async (bookingId) => {
  /// Look up the booking's coordinates AND the service category so we
  /// can filter to partners who actually do this category of work.
  /// Without the category filter, an AC Uninstallation booking was
  /// surfacing electricians + plumbers + general partners — useless
  /// for the admin and tempting overlap.
  const booking = bookingId
    ? await prisma.booking.findUnique({
        where: { id: Number(bookingId) },
        select: {
          lat: true,
          lng: true,
          cityId: true,
          customerAddress: { select: { lat: true, lng: true, cityId: true } },
          items: {
            include: { service: { select: { categoryId: true } } },
            take: 1,
            orderBy: { id: 'asc' },
          },
        },
      })
    : null;
  const bookingLat = booking?.lat ?? booking?.customerAddress?.lat ?? null;
  const bookingLng = booking?.lng ?? booking?.customerAddress?.lng ?? null;
  const bookingCategoryId = booking?.items?.[0]?.service?.categoryId ?? null;
  /// Booking's city — prefer the row's own cityId, fall back to the
  /// snapshotted customer-address cityId. Used to scope nearbyPartners
  /// to the same city as the order so a Nagpur partner can't surface
  /// for a Bangalore booking.
  const bookingCityId = booking?.cityId ?? booking?.customerAddress?.cityId ?? null;

  /// Hard filters: category match (don't show plumbers for an AC job)
  /// + active + verified + same city as the booking. On-duty is a SORT
  /// signal, not a filter — manual dispatch exists precisely because the
  /// broadcast found no acceptor, so an empty list would defeat the
  /// feature. We sort on-duty to the top and let the admin still reach
  /// off-duty ones at the bottom (e.g. to phone them directly).
  ///
  /// `cityId` is nullable on both Partner and Booking; when the booking
  /// has no city set (legacy rows), we skip the city filter so the admin
  /// still sees a usable list rather than nothing.
  const partners = await prisma.partner.findMany({
    where: {
      isActive: true,
      isVerified: true,
      ...(bookingCategoryId != null ? { categoryId: bookingCategoryId } : {}),
      ...(bookingCityId != null ? { cityId: bookingCityId } : {}),
    },
    take: 50,
    orderBy: [{ lastLocationAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    select: {
      id: true,
      name: true,
      phone: true,
      businessName: true,
      categoryId: true,
      currentLat: true,
      currentLng: true,
      lastLocationAt: true,
      /// City for the dispatch modal — prefer the canonical Geography
      /// FK (cityRef.name), fall back to the legacy free-text `city`
      /// column so partners predating the geography backfill still
      /// surface something the admin can verify.
      city: true,
      cityRef: { select: { name: true } },
    },
  });
  if (partners.length === 0) return [];
  const partnerIds = partners.map((p) => p.id);

  /// Resolve category NAMES for display. Partner has no `category`
  /// relation in the schema (only a nullable `categoryId`), so we
  /// batch-fetch the names for whatever distinct category ids appear
  /// and map them in below. One query regardless of partner count.
  const categoryIds = [...new Set(partners.map((p) => p.categoryId).filter((id) => id != null))];
  const categoryRows = categoryIds.length
    ? await prisma.category.findMany({
        where: { id: { in: categoryIds } },
        select: { id: true, name: true },
      })
    : [];
  const categoryNameById = new Map(categoryRows.map((c) => [c.id, c.name]));

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
    ratingAgg.map((r) => [r.partnerId, { avg: r._avg.stars ?? 0, count: r._count._all }]),
  );
  const busyPartnerIds = new Set(activeAgg.map((b) => b.partnerId));

  /// On-duty set + live positions from Redis presence, in one pass.
  ///   onDutyIds      — partners with a fresh `lastseen` key (the
  ///                    accurate "currently on duty" signal).
  ///   livePositions  — Map<id, {lat,lng}> of each on-duty partner's
  ///                    real-time location from the category GEO set.
  /// Both fall back to empty when Redis is disabled.
  const [onDutyIds, livePositions] = await Promise.all([
    dispatchRegistry.filterOnlinePartnerIds(partnerIds),
    bookingCategoryId != null
      ? dispatchRegistry.getOnlinePositions(bookingCategoryId, partnerIds)
      : Promise.resolve(new Map()),
  ]);

  const shaped = partners
    /// Hide busy partners entirely — clicking Assign on one would
    /// create overlapping work. The 409 backend guard + frontend
    /// `disabled` flag are belt-and-braces; this filter is primary.
    .filter((p) => !busyPartnerIds.has(p.id))
    .map((p) => {
      const r = ratingByPartner.get(p.id);
      const onDuty = onDutyIds.has(p.id);

      /// Pick the best-known partner location for the distance calc:
      ///   1. Redis live position (on-duty partners — most accurate)
      ///   2. DB currentLat/Lng (last-known from their last job)
      /// If NEITHER exists, distance is genuinely unknown — we send
      /// `null` rather than a fabricated number so the admin UI can
      /// show "—" instead of a misleading "0.5 km".
      const live = livePositions.get(p.id);
      const partnerLat = live?.lat ?? p.currentLat ?? null;
      const partnerLng = live?.lng ?? p.currentLng ?? null;

      const canMeasure =
        bookingLat != null && bookingLng != null && partnerLat != null && partnerLng != null;
      const distanceKm = canMeasure
        ? Math.round(
            haversineKm(
              { lat: bookingLat, lng: bookingLng },
              { lat: partnerLat, lng: partnerLng },
            ) * 10,
          ) / 10
        : null;

      return {
        id: p.id,
        name: p.name ?? p.businessName ?? 'Partner',
        phone: p.phone,
        distanceKm,
        rating: r ? Math.round(r.avg * 10) / 10 : 0,
        ratingCount: r ? r.count : 0,
        jobsCompleted: completedByPartner.get(p.id) ?? 0,
        /// Show the actual service category the partner is registered
        /// for (matches the booking's category since we filtered on it).
        /// Falls back to businessName then "General" for legacy rows
        /// with no category assigned.
        category:
          (p.categoryId != null ? categoryNameById.get(p.categoryId) : null) ??
          p.businessName ??
          'General',
        /// Canonical city from Geography first, free-text fallback for
        /// partners that predate the geography backfill.
        city: p.cityRef?.name ?? p.city ?? null,
        onDuty,
        status: onDuty ? 'available' : 'off_duty',
      };
    });

  /// Sort: on-duty first; within each group, partners WITH a known
  /// distance come before unknowns, nearest first. Unknown-distance
  /// partners sink to the bottom of their group.
  return shaped.sort((a, z) => {
    if (a.onDuty !== z.onDuty) return a.onDuty ? -1 : 1;
    const ad = a.distanceKm ?? Infinity;
    const zd = z.distanceKm ?? Infinity;
    return ad - zd;
  });
};

/// Widest dispatch radius (km). Mirrors the 7km final wave in
/// dispatch/dispatcher.js DISPATCH_WAVES — the customer "how many
/// partners are nearby" count uses the SAME outer bound the broadcast
/// will eventually reach, so the number it shows matches who could
/// actually be offered the job.
const AVAILABILITY_RADIUS_KM = 7;

/// Live count of online partners who could take THIS booking right now,
/// within the 7km broadcast radius. Customer-facing — the partner-search
/// sheet polls this to show "N partners available nearby" and, when the
/// count is zero, to offer the customer the Schedule / direct-book exits
/// instead of leaving them watching an empty radar.
///
/// Mirrors the dispatcher's candidate logic so the number is honest:
///   - GEOSEARCH each of the booking's service categories within 7km
///   - union + dedupe (a partner registered for two categories counts once)
///   - drop partners currently on an active job (busy)
///   - drop partners who already DECLINED this booking
/// Returns { count, hasNearby, radiusKm }. Soft-fails to count 0 when
/// Redis/geo is unavailable rather than throwing into the customer flow.
exports.availability = async ({ customerId, id }) => {
  const fallback = { count: 0, hasNearby: false, radiusKm: AVAILABILITY_RADIUS_KM };
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: Number(id) },
      select: {
        customerId: true,
        lat: true,
        lng: true,
        customerAddress: { select: { lat: true, lng: true } },
        items: { select: { service: { select: { categoryId: true } } } },
      },
    });
    /// Ownership guard — a customer can only probe their OWN booking's
    /// availability. Soft-fail to the empty result (not a 404) so the
    /// search sheet's poll degrades gracefully instead of erroring.
    if (!booking || booking.customerId !== customerId) return fallback;

    const lat = booking.lat ?? booking.customerAddress?.lat ?? null;
    const lng = booking.lng ?? booking.customerAddress?.lng ?? null;
    if (lat == null || lng == null) return fallback;

    const categoryIds = [
      ...new Set(
        (booking.items ?? [])
          .map((i) => i.service?.categoryId)
          .filter((id) => id != null),
      ),
    ];
    if (categoryIds.length === 0) return fallback;

    /// Union nearby online partners across every cart category, deduped.
    const seen = new Set();
    for (const cat of categoryIds) {
      const rows = await dispatchRegistry.findOnlineNearby({
        categoryId: cat,
        lat,
        lng,
        radiusKm: AVAILABILITY_RADIUS_KM,
        limit: 50,
      });
      for (const r of rows) seen.add(r.partnerId);
    }
    if (seen.size === 0) return fallback;

    const ids = [...seen];

    /// Exclude busy partners (on an active job) — they can't take this.
    const busy = await dispatchRegistry
      .filterActivePartnerIds(ids)
      .catch(() => new Set());
    /// Exclude partners who already declined THIS booking — they won't
    /// be re-offered it, so they shouldn't inflate the "available" count.
    const declined = await dispatchRegistry
      .getDeclinedPartners(Number(id))
      .catch(() => new Set());

    const count = ids.filter((id) => !busy.has(id) && !declined.has(id)).length;
    return { count, hasNearby: count > 0, radiusKm: AVAILABILITY_RADIUS_KM };
  } catch (err) {
    console.warn(`[availability] booking ${id}: ${err.message}`);
    return fallback;
  }
};

/// Arrival-promise ETA for the customer HOME badge. Finds the nearest
/// online partner of ANY category near (lat, lng) and converts the distance
/// to minutes. No booking required — it's a "someone can reach you in ~N
/// min" promise. Returns { available, minutes } — `available:false` when no
/// partner is online within range (the app then hides the badge rather than
/// showing a fake number).
///
/// Formula: urban travel ≈ 20 km/h ≈ 3 min/km, plus a small prep/accept
/// buffer, clamped to a sensible [MIN, MAX] band so it always reads as a
/// crisp promise (never "0 min" or a scary large number).
const ETA_RADIUS_KM = 10;
const ETA_MIN_PER_KM = 3;
const ETA_BASE_MIN = 2;
const ETA_FLOOR_MIN = 8;
const ETA_CAP_MIN = 30;
exports.nearbyEta = async ({ lat, lng }) => {
  const fallback = { available: false, minutes: null };
  try {
    if (lat == null || lng == null) return fallback;
    const km = await dispatchRegistry
      .nearestOnlinePartnerKm({ lat: Number(lat), lng: Number(lng), radiusKm: ETA_RADIUS_KM })
      .catch(() => null);
    if (km == null) return fallback;
    const raw = Math.round(ETA_BASE_MIN + km * ETA_MIN_PER_KM);
    const minutes = Math.min(ETA_CAP_MIN, Math.max(ETA_FLOOR_MIN, raw));
    return { available: true, minutes };
  } catch (err) {
    console.warn(`[nearbyEta] ${err.message}`);
    return fallback;
  }
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

  /// Defense in depth — the admin UI now blocks Assign on busy partners
  /// before the request fires, but server should reject too so a bug
  /// in the UI / a direct API call can't create overlapping
  /// assignments. `partnerHasActiveJob` matches what the partner-side
  /// `partnerAccept` uses, so the two paths agree on "busy".
  if (await partnerHasActiveJob(partner.id)) {
    throw ApiError.conflict(
      `${partnerLabel} already has an active job. Wait for them to finish or pick a different partner.`,
    );
  }

  const updated = await prisma.booking.update({
    where: { id: Number(bookingId) },
    data: {
      partnerId: partner.id,
      status: 'CONFIRMED',
      assignedAt: new Date(),
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

  /// Also fire an FCM push so the partner gets a tray notification
  /// even when their app is closed / minimized / Vivo has killed the
  /// foreground service. Without this, the bell-icon socket event
  /// inside notifications.create only reaches them if their socket
  /// is still connected — which on aggressive OEMs is unreliable.
  /// Mirrors what the dispatcher does for the normal wave path.
  const headService = updated.items?.[0]?.serviceName ?? 'Service';
  /// Same single-source-of-truth pricing as the dispatcher: grandTotal
  /// is the customer-facing all-in amount the partner-app surfaces
  /// inside the job-request screen, so the assign notification quotes
  /// the same number. BYOP wins, grandTotal next, legacy `total` last.
  const amount = updated.offeredPrice ?? updated.grandTotal ?? updated.total ?? 0;
  /// Ring the partner-app's "New job assigned" alert (5s vibrate +
  /// sound) over the live socket when their app is open + connected.
  /// Distinct from the dispatch.offer path: this job is already theirs,
  /// so there's no Accept/Decline — it's a heads-up, not an offer.
  const partnerConnected = await dispatcher.isPartnerConnected(partner.id);
  if (partnerConnected) {
    dispatcher.emitToPartner(partner.id, 'job.assigned', {
      bookingId: Number(bookingId),
      serviceName: headService,
      amount,
    });
  } else {
    /// No live socket — the partner's app is closed/frozen, so reach them
    /// with the hybrid OS-rendered FCM push instead. Gating on connection
    /// keeps it to one alert: a connected partner gets the socket ring
    /// above, a disconnected one gets the device notification here.
    /// "New job assigned" copy (not the offer "New job request!") so the
    /// tray notification matches the in-app alert, and tapping it opens
    /// the booking instead of the Accept/Decline offer flow.
    try {
      const { sendJobAssignedPush } = require('../notifications/push.service');
      void sendJobAssignedPush(
        prisma,
        partner.id,
        { bookingId: Number(bookingId), serviceName: headService, amount },
      );
    } catch (err) {
      console.warn(`Admin-assign push failed for booking ${bookingId}: ${err.message}`);
    }
  }

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

  /// Free the assigned partner (if any) — clear the BUSY flag so they
  /// can receive new offers again after an admin pulls their job.
  if (b.partnerId) {
    await dispatchRegistry.clearActiveJob(b.partnerId).catch(() => {});
    require('../tracking/tracking.service').setBusyState({ partnerId: b.partnerId, busy: false });
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

  /// Authoritative off-duty gate. A partner who toggled off duty must
  /// never receive offers, even if their app is still polling (e.g. a
  /// background poll that slips through before the toggle's teardown
  /// completes, or a stale request after a location change). Return an
  /// empty list AND skip the upsertOnline below so this poll can't
  /// re-register them as available.
  if (dispatchRegistry.enabled() && (await dispatchRegistry.isOffDuty(partnerId))) {
    return [];
  }

  const coords = lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : null;
  if (!coords) return [];

  /// Push-mode side-effect: every poll counts as a presence ping. So
  /// even if the partner-app hasn't been converted to Socket.io yet,
  /// the dispatcher's GEOSEARCH still finds them. Refreshes the
  /// last-seen TTL on each call. (upsertOnline itself also re-checks
  /// the off-duty flag as a final guard.)
  if (dispatchRegistry.enabled()) {
    await dispatchRegistry.upsertOnline({
      partnerId: Number(partnerId),
      categoryId: partner.categoryId,
      lat: coords.lat,
      lng: coords.lng,
    });
  }

  /// Mirror this on-duty coordinate into the DB (throttled ~60s) so
  /// `partner.currentLat/Lng` stays fresh between jobs for the admin
  /// nearby-partners view + the accept-time radius fallback. Same
  /// best-effort mirror the socket presence path does; fire-and-forget.
  {
    const tracking = require('../tracking/tracking.service');
    void tracking.mirrorPresenceLocation({
      partnerId: Number(partnerId),
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
        /// Keep the offer visible to already-offered partners through
        /// `needs_admin_dispatch` too — after the automated broadcast
        /// attempts finish, the booking is still PENDING + unassigned
        /// and `partnerAccept` explicitly whitelists that state, so the
        /// partner can still grab it. This is what lets multiple offers
        /// stack in the JobOffersSheet without an older one vanishing the
        /// moment the automated window closes. The TERMINAL states (payment_timeout,
        /// superseded, no_partner_found, assigned) are excluded because
        /// the booking is no longer acceptable — so cancelled / taken /
        /// admin-assigned offers correctly drop out of the partner's
        /// list on the next poll.
        dispatchStatus: { in: ['waiting', 'broadcasting', 'needs_admin_dispatch'] },
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
    /// `lat/lng` + `dispatchRadiusKm` are pulled so we can re-enforce
    /// the dispatch radius as a HARD cap at accept-time (see below).
    select: {
      id: true,
      status: true,
      partnerId: true,
      lat: true,
      lng: true,
      dispatchStatus: true,
      dispatchRadiusKm: true,
      offeredPrice: true,
      items: { include: { service: { select: { categoryId: true } } } },
    },
  });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.status !== 'PENDING') throw ApiError.conflict('Booking is no longer available');
  if (b.partnerId !== null) throw ApiError.conflict('Booking already accepted by another partner');
  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    /// `currentLat/currentLng` are the DB fallback for the accept-time
    /// radius check when the partner has no live Redis presence position.
    select: {
      categoryId: true,
      isActive: true,
      isVerified: true,
      currentLat: true,
      currentLng: true,
    },
  });
  if (!partner?.isActive || !partner?.isVerified) throw ApiError.forbidden('Partner is not active');
  const categoryMatches = b.items.some((i) => i.service?.categoryId === partner.categoryId);
  if (!categoryMatches) throw ApiError.forbidden('Booking category does not match your profile');

  /// HARD accept-time radius cap. The dispatch waves only enforce the
  /// 3/5/7km radius at BROADCAST time, against the coordinate the
  /// partner's app reported in its presence ping — which can be stale,
  /// cached, or a hardcoded default. That let a partner who is actually
  /// ~22km away (but reported a nearby coordinate) both receive AND
  /// accept an instant 7km booking. This is the last line of defense:
  /// recompute the real distance at accept-time and refuse if the
  /// partner is beyond the booking's radius (+ a small GPS-jitter
  /// buffer so a partner sitting right on the boundary isn't bounced).
  ///
  /// `partnerAccept` is only ever a PARTNER self-claim (admin assignment
  /// goes through `reassign`), so there's no admin actor to exempt.
  /// We skip the check only when we genuinely can't locate one side —
  /// failing open there preserves the legacy behaviour rather than
  /// blocking an accept on missing data.
  const ACCEPT_RADIUS_BUFFER_KM = 1.5;
  const capRadiusKm = (b.dispatchRadiusKm ?? FINAL_DISPATCH_WAVE.radiusKm) + ACCEPT_RADIUS_BUFFER_KM;
  /// Prefer the partner's LIVE presence position (Redis geo set, set by
  /// the last presence ping) over the DB `currentLat/Lng` snapshot —
  /// the live one is what dispatch actually matched against. Fall back
  /// to the DB columns when there's no live entry.
  let partnerCoords = null;
  if (partner.categoryId != null) {
    const positions = await dispatchRegistry
      .getOnlinePositions(partner.categoryId, [Number(partnerId)])
      .catch(() => new Map());
    partnerCoords = positions.get(Number(partnerId)) ?? null;
  }
  if (!partnerCoords && partner.currentLat != null && partner.currentLng != null) {
    partnerCoords = { lat: partner.currentLat, lng: partner.currentLng };
  }
  if (
    partnerCoords &&
    b.lat != null &&
    b.lng != null
  ) {
    const distanceKm = haversineKm(partnerCoords, { lat: b.lat, lng: b.lng });
    if (distanceKm > capRadiusKm) {
      /// Release the Redis claim we grabbed above so another (nearer)
      /// partner can still take this booking.
      await dispatchRegistry.clearBooking(id).catch(() => {});
      throw ApiError.forbidden(
        `You're too far from this booking (${distanceKm.toFixed(1)} km away, limit ${b.dispatchRadiusKm ?? FINAL_DISPATCH_WAVE.radiusKm} km).`,
      );
    }
  }
  /// Previously we required the booking to be inside the formal
  /// broadcast window (`dispatchWindowFor` returns a wave only during
  /// active attempts). A partner who saw an alert near the edge of an
  /// attempt and tapped Accept just after it rolled over was getting
  /// "not currently in broadcast window" with no recourse.
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
      assignedAt: new Date(),
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

  /// Mark the partner BUSY so subsequent dispatch waves for OTHER
  /// bookings stop offering jobs to them while they finish this one.
  /// `removeOnline` (below) pulls them out of the geo set once, but
  /// their app keeps sending presence pings as they drive — without
  /// this flag `upsertOnline` would re-add them ~15s later and they'd
  /// get new push/socket offers mid-job. Cleared on completion / cancel.
  /// Set regardless of queue mode so the legacy poll path benefits too.
  await dispatchRegistry.setActiveJob(partnerId).catch(() => {});
  /// Mirror to the queryable DB column: partner is now BUSY (on a job).
  require('../tracking/tracking.service').setBusyState({ partnerId, busy: true });

  /// Cancel the queued wave + expiry jobs and clear Redis state — no
  /// need to fan out further or expire something that's now in flight.
  /// Also pull the partner from the online geo-set so subsequent waves
  /// for OTHER bookings don't keep offering jobs to someone who's now
  /// busy. The `partner:active` flag set above keeps them out against
  /// their own presence pings until the job completes.
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

/// Partner backs out of a job they'd already accepted. The booking is
/// RELEASED back to the dispatch pool (status → PENDING, partner
/// cleared, fresh broadcast waves) so the customer keeps their slot and
/// another nearby partner can pick it up. The cancelling partner incurs
/// the policy penalty (a pending PartnerAdjustment netted from their
/// next payout) and a strike; crossing the rolling-7-day strike limit
/// auto-suspends their account.
exports.partnerCancel = async ({ partnerId, id, reason }) => {
  const bookingId = Number(id);
  const pid = Number(partnerId);

  const b = await prisma.booking.findUnique({
    where: { id: bookingId },
    /// Fields scheduleAllForBooking needs to recompute the dispatch
    /// start time, plus ownership/state guards.
    select: {
      id: true, partnerId: true, status: true, customerId: true, notes: true,
      isInstant: true, offeredPrice: true, scheduledAt: true, createdAt: true,
    },
  });
  if (!b || b.partnerId !== pid) throw ApiError.notFound('Booking not found');
  /// Only a job that's accepted-but-not-started can be released. Once
  /// IN_PROGRESS (start-OTP verified) re-broadcasting a half-done job
  /// is unsafe — those route through support/admin instead.
  if (b.status !== 'CONFIRMED') {
    throw ApiError.badRequest(
      b.status === 'IN_PROGRESS'
        ? 'This job has already started — contact support to cancel.'
        : 'Only an accepted booking can be cancelled.',
    );
  }

  const policy = await policyService.getCancellation();
  const penalty = Math.max(0, Number(policy.partnerPenalty) || 0);
  const strikeLimit = Math.max(1, Number(policy.partnerStrikeLimit) || 1);
  const windowStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const note = appendNote(
    b.notes,
    `Partner #${pid} cancelled${reason ? `: ${reason}` : ''} — released to pool`,
  );

  const { strikes, suspended } = await prisma.$transaction(async (tx) => {
    /// Race-safe release — only flip a row still CONFIRMED + assigned to
    /// THIS partner, so a simultaneous customer-cancel / admin-reassign
    /// can't be clobbered.
    const released = await tx.booking.updateMany({
      where: { id: bookingId, partnerId: pid, status: 'CONFIRMED' },
      data: {
        partnerId: null,
        status: 'PENDING',
        dispatchStatus: 'waiting',
        dispatchWave: 0,
        dispatchStartedAt: null,
        dispatchExpiresAt: null,
        dispatchRadiusKm: null,
        noPartnerReason: null,
        /// BYOP pay-hold no longer applies while we hunt for a new partner.
        paymentDeadlineAt: null,
        notes: note,
      },
    });
    if (released.count === 0) {
      throw ApiError.conflict('This booking can no longer be cancelled.');
    }

    /// One row per cancel — written even when penalty is ₹0 so the
    /// strike count below stays accurate regardless of the rupee amount.
    await tx.partnerAdjustment.create({
      data: {
        partnerId: pid,
        bookingId,
        type: 'cancellation_penalty',
        amount: penalty,
        reason: reason
          ? `Cancelled booking #${bookingId}: ${reason}`
          : `Cancelled booking #${bookingId}`,
        status: 'pending',
      },
    });

    /// Rolling 7-day strike count, including the row just created.
    const strikeCount = await tx.partnerAdjustment.count({
      where: {
        partnerId: pid,
        type: 'cancellation_penalty',
        createdAt: { gte: windowStart },
      },
    });

    let didSuspend = false;
    if (strikeCount >= strikeLimit) {
      await tx.partner.update({
        where: { id: pid },
        data: {
          isActive: false,
          suspendReason: `Auto-suspended: ${strikeCount} cancellations in 7 days (limit ${strikeLimit}).`,
          suspendedAt: new Date(),
        },
      });
      didSuspend = true;
    }

    return { strikes: strikeCount, suspended: didSuspend };
  });

  /// Partner is no longer on this job. Clear the BUSY flag either way, but
  /// the follow-on differs by whether this cancel auto-suspended them:
  ///   - NOT suspended → setBusyState(false) re-enables them for new jobs.
  ///   - SUSPENDED     → they're blocked, so do NOT re-enable. Yank them
  ///                     out of the dispatch pool (off-duty + presence
  ///                     cleared) so they stop getting offers immediately,
  ///                     instead of lingering for the sticky TTL. Without
  ///                     this, the very cancel that suspended them would
  ///                     put them back in the pool.
  await dispatchRegistry.clearActiveJob(pid).catch(() => {});
  if (suspended) {
    const partnerRow = await prisma.partner
      .findUnique({ where: { id: pid }, select: { categoryId: true } })
      .catch(() => null);
    await dispatchRegistry
      .setOffDuty({ partnerId: pid, categoryId: partnerRow?.categoryId ?? null })
      .catch(() => {});
    await prisma.partner
      .update({ where: { id: pid }, data: { onDuty: false, dutyState: 'off_duty' }, select: { id: true } })
      .catch(() => {});
    await dispatchRegistry.clearDutyMirror(pid).catch(() => {});
  } else {
    require('../tracking/tracking.service').setBusyState({ partnerId: pid, busy: false });
  }

  /// Exclude this partner from future waves for THIS booking — they
  /// walked away from it, so re-dispatch must not re-offer them the same
  /// job. handleWave filters the candidate list against this set.
  await dispatchRegistry.addDeclinedPartner(bookingId, pid).catch(() => {});

  /// Re-broadcast outside the txn. Clear any stale queue/registry state
  /// first, then schedule fresh waves off the (now PENDING) booking.
  /// scheduleAllForBooking no-ops when the dispatch queue is disabled —
  /// the booking then waits in `needs_admin_dispatch`-style limbo for
  /// manual assignment, which is the same fallback the create path has.
  await dispatcher.cancelAllForBooking(bookingId).catch(() => {});
  await dispatcher.scheduleAllForBooking(b).catch((err) => {
    console.warn(`Re-dispatch after partner cancel failed for booking ${bookingId}: ${err.message}`);
  });

  /// Tell the customer their assigned partner dropped off and we're
  /// re-matching — best-effort push, never blocks the cancel.
  try {
    const { sendPush } = require('../notifications/push.service');
    const customer = await prisma.customer.findUnique({
      where: { id: b.customerId },
      select: { expoPushToken: true },
    });
    if (customer?.expoPushToken) {
      void sendPush(customer.expoPushToken, {
        title: 'Finding you another professional',
        body: `Your partner couldn't make booking #${bookingId}. We're matching you with someone new.`,
        data: { bookingId: String(bookingId), type: 'job_reassigning' },
      });
    }
  } catch (err) {
    console.warn(`Customer re-match push failed for booking ${bookingId}: ${err.message}`);
  }

  /// Partner-facing confirmations: the penalty notice, plus a suspend
  /// notice when this cancel tipped them over the strike limit.
  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: pid,
    type: 'job_cancelled',
    title: 'You cancelled a job',
    body:
      penalty > 0
        ? `Booking #${bookingId} released. A ₹${penalty} penalty applies to your next payout.`
        : `Booking #${bookingId} released back to the pool.`,
    bookingId,
  });
  if (suspended) {
    await notifications.create({
      partnerId: pid,
      type: 'system',
      title: 'Account suspended',
      body: `You've reached ${strikes} cancellations in 7 days. Your account is suspended — contact support.`,
    });
  }

  return {
    ok: true,
    bookingId,
    penalty,
    strikes,
    strikeLimit,
    suspended,
  };
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
  const shaped = bookings.map((b) => partnerShape(b, null, commissionMap));

  /// History also surfaces jobs the partner CANCELLED themselves. When a
  /// partner cancels an accepted job we RELEASE it back to the pool — the
  /// booking row's `partnerId` is nulled and status flips to PENDING, so
  /// the query above (which keys on partnerId) can't find it and the job
  /// vanished from the partner's Past tab. The durable record that THIS
  /// partner cancelled THIS booking is the `cancellation_penalty`
  /// PartnerAdjustment row. We fetch those bookings here and shape them
  /// with the status FORCED to 'cancelled' (their live status may now be
  /// PENDING/CONFIRMED/COMPLETED under a different partner — irrelevant to
  /// this partner's own history).
  ///
  /// Run for the 'history' bucket AND the no-bucket call (the partner app
  /// fetches /partner/mine with NO bucket and splits Upcoming/Past client-
  /// side by status, so the cancellations must be in that combined list).
  /// Skip only the 'active' bucket, which is strictly in-flight jobs.
  if (bucket !== 'active') {
    const cancelAdjustments = await prisma.partnerAdjustment.findMany({
      where: { partnerId, type: 'cancellation_penalty', bookingId: { not: null } },
      select: { bookingId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    /// Drop ids already in `shaped` (a booking that was cancelled and
    /// never re-assigned still has partnerId set + status CANCELLED, so it
    /// can appear in BOTH lists — show it once).
    const already = new Set(shaped.map((s) => Number(s.id)));
    const cancelledIds = [
      ...new Set(
        cancelAdjustments
          .map((a) => a.bookingId)
          .filter((id) => id != null && !already.has(id)),
      ),
    ];
    if (cancelledIds.length > 0) {
      const cancelledBookings = await prisma.booking.findMany({
        where: { id: { in: cancelledIds } },
        include: PARTNER_INCLUDE,
      });
      /// Force the partner-facing status to 'cancelled' regardless of the
      /// booking's current live status (it may have been re-accepted by
      /// someone else). From THIS partner's perspective, they cancelled it.
      const cancelShaped = cancelledBookings.map((b) => ({
        ...partnerShape(b, null, commissionMap),
        status: 'cancelled',
        cancelledByPartner: true,
      }));
      shaped.push(...cancelShaped);
    }
  }

  /// Newest first across the merged set. partnerShape carries the booking
  /// timestamps; sort by createdAt desc as a stable, meaningful order.
  shaped.sort(
    (a, z) => new Date(z.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
  );
  return shaped;
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
      customerId: true,
      status: true,
      jobStartOtp: true,
      jobCompleteOtp: true,
    },
  });
  if (!b) throw ApiError.notFound('Booking not found');
  if (b.partnerId !== partnerId) throw ApiError.forbidden('Not your booking');

  /// 'arrived' is a SUB-STATE of the en-route (CONFIRMED) phase, not a
  /// status enum value. We persist `arrivedAt` and DON'T change `status`,
  /// so the partner's "You have arrived" state survives an app restart
  /// and the customer/admin can see it. Must be CONFIRMED to arrive, and
  /// idempotent (re-marking just keeps the first timestamp).
  if (status === 'arrived') {
    if (b.status !== 'CONFIRMED') {
      throw ApiError.badRequest('Can only mark arrival on a confirmed booking.');
    }
    const updatedArr = await prisma.booking.update({
      where: { id },
      data: { arrivedAt: new Date() },
      include: PARTNER_INCLUDE,
    });
    /// Push the arrival to the customer-app's tracking screen instantly
    /// (it otherwise only sees it on its next poll). Also notify any
    /// connected admin so the live timeline updates. Best-effort.
    try {
      dispatcher.emitToCustomer(b.customerId, 'booking.partner_arrived', {
        bookingId: id,
        arrivedAt: updatedArr.arrivedAt,
      });
    } catch { /* socket optional — poll catches up */ }
    const commissionMap = await loadCommissionMap();
    return partnerShape(updatedArr, null, commissionMap);
  }

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

  /// Push the status change to the customer's tracking screen instantly.
  /// Without this the start-OTP card lingers until the customer's next 6s
  /// poll after the partner starts the job — the exact "still showing the
  /// start OTP" lag. Best-effort; the HTTP poll is the fallback if the
  /// socket is down. (Arrival emits its own `booking.partner_arrived`
  /// above; this covers in_progress + completed.)
  try {
    dispatcher.emitToCustomer(b.customerId, 'booking.updated', {
      bookingId: id,
      status: dbStatus,
      jobStartedAt: updated.jobStartedAt ?? null,
      jobCompletedAt: updated.jobCompletedAt ?? null,
    });
  } catch { /* socket optional — poll catches up */ }

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
    /// Job done — clear the BUSY flag so the partner's next presence
    /// ping re-adds them to the dispatch pool and they can be offered
    /// new jobs again.
    await dispatchRegistry.clearActiveJob(partnerId).catch(() => {});
    require('../tracking/tracking.service').setBusyState({ partnerId, busy: false });
  }

  const commissionMap = await loadCommissionMap();
  return partnerShape(updated, null, commissionMap);
};
