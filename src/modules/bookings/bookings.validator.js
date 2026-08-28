const { z } = require('zod');

const idParam = z.object({
  params: z.object({
    id: z.coerce.number().int().positive('Invalid booking id'),
  }),
});

const itemSchema = z.object({
  serviceId: z.number().int().positive(),
  qty: z.number().int().min(1, 'qty must be at least 1').max(20, 'qty too large'),
});

const createSchema = z.object({
  body: z.object({
    items: z.array(itemSchema).min(1, 'Cart cannot be empty').max(20),

    scheduledAt: z.string().datetime('scheduledAt must be ISO timestamp'),
    slotLabel: z.string().trim().min(1).max(80),
    isInstant: z.boolean().optional(),

    /// Optional pointer to a saved CustomerAddress. When present the
    /// service derives the snapshot from that row (and ignores any
    /// inline addressLine/city/etc. in the body), so the client can
    /// just send `customerAddressId` after the user picks one. When
    /// absent, the inline fields below are required (one-off typed
    /// addresses still work for guests / first-time bookings).
    customerAddressId: z.number().int().positive().optional(),

    addressLabel: z.string().trim().min(1).max(40).default('Home'),
    addressLine: z.string().trim().min(5, 'Full address is required').max(300).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    pincode: z.string().trim().regex(/^\d{3,8}$/, 'Invalid pincode').optional(),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),

    discount: z.number().int().min(0).max(10_000_000).optional(),
    notes: z.string().trim().max(500).optional(),
    /// optional customer-offered price — drives the "Book at your price" flow
    offeredPrice: z.number().int().min(0).max(10_000_000).optional(),
    /// optional coupon code — backend re-validates against the cart and
    /// applies the discount inside the same transaction as the booking
    /// insert so a coupon redemption is never burned without a booking.
    couponCode: z.string().trim().max(30).optional(),
  })
    .refine((v) => v.offeredPrice == null || v.isInstant === true, {
      message: 'Book at your price is available only for instant bookings',
      path: ['offeredPrice'],
    })
    .refine((v) => Boolean(v.customerAddressId) || (v.addressLine && v.city), {
      message: 'Either customerAddressId or addressLine + city must be provided',
      path: ['addressLine'],
    }),
});

/// Admin "create job on behalf of a customer" — same shape as the
/// customer createSchema plus the target customerId. Coupons and BYOP
/// (offeredPrice) are deliberately left out: those are customer-side
/// flows; an admin books at catalog price. Payment stays "unpaid" —
/// the admin collects via the existing Mark-Paid (cash) action or the
/// customer pays in-app.
const adminCreateSchema = z.object({
  body: z
    .object({
      customerId: z.number().int().positive('customerId is required'),
      items: z.array(itemSchema).min(1, 'Cart cannot be empty').max(20),
      scheduledAt: z.string().datetime('scheduledAt must be ISO timestamp'),
      slotLabel: z.string().trim().min(1).max(80),
      isInstant: z.boolean().optional(),
      customerAddressId: z.number().int().positive().optional(),
      addressLabel: z.string().trim().min(1).max(40).default('Home'),
      addressLine: z.string().trim().min(5, 'Full address is required').max(300).optional(),
      city: z.string().trim().min(1).max(80).optional(),
      pincode: z.string().trim().regex(/^\d{3,8}$/, 'Invalid pincode').optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      discount: z.number().int().min(0).max(10_000_000).optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .refine((v) => Boolean(v.customerAddressId) || (v.addressLine && v.city), {
      message: 'Either customerAddressId or addressLine + city must be provided',
      path: ['addressLine'],
    }),
});

// ── Admin filters ───────────────────────────────────────────────────────────

const adminListQuerySchema = z.object({
  query: z.object({
    status: z.string().optional(),
    /// Legacy combined search — kept so older clients still work.
    search: z.string().trim().max(100).optional(),
    /// Targeted filters. When set, each one ANDs into the WHERE clause
    /// — typing "51" into bookingId returns only booking #51, not
    /// every row whose phone happens to contain "51".
    ///
    /// Accepts the human-facing Booking ID (e.g. "DHND290526001", full
    /// or partial) OR the raw numeric id. The service matches a
    /// pure-digit value by `id` and anything else against `bookingRef`
    /// (case-insensitive substring), so this is a bounded string rather
    /// than a coerced number.
    bookingId: z.string().trim().max(40).optional(),
    customer: z.string().trim().max(100).optional(),
    partner: z.string().trim().max(100).optional(),
    partnerId: z.coerce.number().int().positive().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    /// Geography filters — used by the admin panel's State→City
    /// cascade. cityId is most precise; stateId on its own returns
    /// every booking in that state's active cities.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    /// Dispatch state filter — surfaces the Manual Dispatch queue
    /// (`needs_admin_dispatch`) and other tactical lists.
    dispatchStatus: z.string().trim().max(40).optional(),
    /// Comma-separated list of statuses to hide from the result —
    /// used by Booking History to default-hide CANCELLED rows so
    /// the admin's operational view stays focused on live work.
    excludeStatus: z.string().trim().max(80).optional(),
    /// Booking-type filter — Instant / Scheduled / Book-at-price (BYOP).
    bookingType: z.enum(['instant', 'scheduled', 'byop']).optional(),
    /// Payment filter. The dashboard's "Recent bookings" uses
    /// `paymentStatus=paid` so it shows real, money-backed activity
    /// instead of abandoned checkout attempts.
    paymentStatus: z.enum(['unpaid', 'pending', 'paid', 'failed', 'refunded']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const disputesListQuerySchema = z.object({
  query: z.object({
    status: z.string().optional(),
    search: z.string().trim().max(100).optional(),
    page: z.coerce.number().int().min(1).optional(),
  }),
});

const resolveDisputeSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    resolution: z.string().trim().min(1).max(500),
    action: z.enum(['refund', 'credit', 'penalty', 'close']),
  }),
});

const disputeNoteSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z.object({ text: z.string().trim().min(1).max(500) }),
});

const dispatchSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    partnerId: z.coerce.number().int().positive(),
    reason: z.string().trim().max(300).optional(),
  }),
});

const adminStatusSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    status: z.enum(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
    note: z.string().trim().max(300).optional(),
  }),
});

const adminCancelSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    reason: z.string().trim().min(1).max(300),
  }),
});

const adminMarkPaidSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      /// "cash" is the common case (partner collected on completion);
      /// other values supported so an admin reconciling a UPI / bank
      /// transfer can capture how the money came in.
      method: z.enum(['cash', 'upi', 'bank_transfer', 'razorpay']).default('cash'),
      /// Optional override — defaults to the booking's offeredPrice
      /// when set, else `total`. Useful when the partner only
      /// collected a partial amount (rare, but happens).
      amount: z.number().int().positive().max(10_000_000).optional(),
      note: z.string().trim().max(300).optional(),
    })
    .default({}),
});

const adminRescheduleSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    scheduledAt: z.string().datetime('scheduledAt must be ISO timestamp'),
    slotLabel: z.string().trim().min(1).max(80).optional(),
    reason: z.string().trim().max(300).optional(),
  }),
});

const listMineQuerySchema = z.object({
  query: z.object({
    status: z
      .enum(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
      .optional(),
    /** "upcoming" or "past" — convenience filter */
    bucket: z.enum(['upcoming', 'past']).optional(),
  }),
});

const cancelSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      reason: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
});

const rateBookingSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    stars: z.coerce.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
  }),
});

const partnerIncomingQuerySchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().min(0.5).max(50).default(5),
  }),
});

/// Home arrival-promise ETA — lat/lng required (the badge only requests it
/// once the customer's location is known).
const nearbyEtaQuerySchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
  }),
});

/// Pre-checkout instant availability probe. `serviceIds` is a CSV so the
/// cart can pass its line items in a plain GET.
const instantAvailabilityQuerySchema = z.object({
  query: z.object({
    lat: z.coerce.number().min(-90).max(90),
    lng: z.coerce.number().min(-180).max(180),
    serviceIds: z.string().trim().min(1),
  }),
});

const partnerStatusSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    status: z.enum(['arrived', 'in_progress', 'completed']),
    /// 4-digit handoff OTP read aloud by the customer. Optional only so
    /// legacy bookings created before the OTP rollout can still be
    /// progressed; new bookings have a code on the row and the service
    /// rejects mismatches.
    otp: z.string().trim().regex(/^\d{4}$/, 'OTP must be 4 digits').optional(),
  }),
});

const partnerMineQuerySchema = z.object({
  query: z.object({
    bucket: z.enum(['active', 'history']).optional(),
  }),
});

/// One add-on line: either a catalog pick (serviceId) or a custom line
/// (name + price). qty defaults to 1 server-side.
const addOnItemSchema = z
  .object({
    serviceId: z.number().int().positive().optional(),
    name: z.string().trim().min(2, 'Name too short').max(80).optional(),
    price: z.number().int().min(1, 'Price must be at least ₹1').max(100000).optional(),
    qty: z.number().int().min(1).max(20).optional(),
  })
  .refine((it) => it.serviceId != null || (it.name && it.price != null), {
    message: 'Each add-on needs a serviceId, or a name and price for custom add-ons',
  });

const partnerAddOnsSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    items: z.array(addOnItemSchema).min(1, 'Pick at least one add-on').max(20),
  }),
});

const partnerRemoveAddOnSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive(),
    addOnId: z.coerce.number().int().positive(),
  }),
});

/// Partner backing out of an accepted job. Reason is optional (the
/// partner-app offers a quick reason list but lets them skip it) and
/// capped like the customer cancel reason.
const partnerCancelSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      reason: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
});

module.exports = {
  idParam,
  createSchema,
  listMineQuerySchema,
  cancelSchema,
  partnerCancelSchema,
  adminCreateSchema,
  adminListQuerySchema,
  disputesListQuerySchema,
  resolveDisputeSchema,
  disputeNoteSchema,
  dispatchSchema,
  adminStatusSchema,
  adminCancelSchema,
  adminMarkPaidSchema,
  adminRescheduleSchema,
  partnerIncomingQuerySchema,
  partnerStatusSchema,
  partnerMineQuerySchema,
  partnerAddOnsSchema,
  partnerRemoveAddOnSchema,
  rateBookingSchema,
  nearbyEtaQuerySchema,
  instantAvailabilityQuerySchema,
};
