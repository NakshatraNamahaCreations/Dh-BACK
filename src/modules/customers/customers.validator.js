const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive('Invalid id') }),
});

const listQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'paused', 'all']).optional(),
    sort: z.enum(['recent', 'spend', 'bookings']).optional(),
    /// Geography filter — scopes customers by their bookings' cityId.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

// ── Customer-facing saved-address CRUD ─────────────────────────────────────

const addressBody = z.object({
  label: z.string().trim().min(1, 'Label is required').max(40),
  addressLine: z.string().trim().min(5, 'Full address is required').max(300),
  city: z.string().trim().min(1).max(80),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Pincode must be 6 digits')
    .optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  /// Structured detail captured on the "Add address details" screen.
  /// All optional + length-capped; the app composes the visible
  /// `addressLine` from these, so they're supplementary.
  floor: z.string().trim().max(40).optional(),
  building: z.string().trim().max(120).optional(),
  landmark: z.string().trim().max(120).optional(),
  receiverName: z.string().trim().max(80).optional(),
  /// Loose check — the app enforces a real phone format in the UI; we
  /// just guard length so a stray paste can't bloat the column.
  receiverPhone: z.string().trim().max(20).optional(),
  /// When true, the create/update endpoint clears any other default for
  /// this customer atomically.
  isDefault: z.boolean().optional(),
});

const createAddressSchema = z.object({ body: addressBody });

/// Update is a partial — every field becomes optional. Reusing the body
/// above keeps validation rules (length / regex / lat range) consistent
/// between create and update.
const updateAddressSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: addressBody.partial(),
});

const addressIdParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

/// Admin "create customer" (used by the Create-job flow when the person
/// has never used the app). Phone normalises to the last 10 digits —
/// same rule the OTP login uses — so when the customer later signs in
/// with that number they land on THIS account and see their bookings.
const adminCreateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Name is required').max(80),
    phone: z
      .string()
      .trim()
      .transform((p) => p.replace(/\D/g, '').slice(-10))
      .refine((p) => /^[6-9]\d{9}$/.test(p), 'Enter a valid 10-digit mobile number'),
    email: z.string().trim().email().max(120).optional(),
  }),
});

module.exports = {
  idParam,
  listQuerySchema,
  createAddressSchema,
  updateAddressSchema,
  addressIdParam,
  adminCreateSchema,
};
