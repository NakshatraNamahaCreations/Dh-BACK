const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive('Invalid partner id') }),
});

const listQuerySchema = z.object({
  query: z.object({
    status: z.string().optional(),
    kyc: z.string().optional(),
    search: z.string().trim().max(100).optional(),
    /// Geography filters — admin's State→City cascade.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const onboardingQuerySchema = z.object({
  query: z.object({
    status: z.string().optional(),
    search: z.string().trim().max(100).optional(),
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const statusSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      status: z.enum(['active', 'paused', 'suspended']),
      /// Required when suspending — appears on the partner's home
      /// banner and on admin lists. The service rejects a suspend
      /// request without a reason.
      reason: z.string().trim().min(3).max(300).optional(),
    })
    /// "Suspending without telling the partner why" is a footgun —
    /// the partner-app would just silently stop working. Force the
    /// admin to type a sentence explaining what happened.
    .refine((v) => v.status !== 'suspended' || (v.reason && v.reason.length > 0), {
      message: 'A reason is required when suspending an account.',
      path: ['reason'],
    }),
});

const stageSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    stage: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'done', 'failed', 'skipped']),
    note: z.string().optional(),
  }),
});

const rejectSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({ reason: z.string().optional() }).default({}),
});

const onboardingFeeSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    amount: z.coerce.number().int().positive().max(1_000_000),
    note: z.string().trim().max(500).optional(),
  }),
});

const trainingStatusSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    completed: z.boolean(),
  }),
});

const skipDlSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    reason: z.string().trim().min(3).max(500).optional(),
  }).default({}),
});

/// Admin-only category reassignment. Partners can't edit their own
/// category from the partner-app (it's set during onboarding and
/// locked from then on); only admin can move them between trades
/// here. `categoryId: null` clears the assignment.
const updateCategorySchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    categoryId: z.coerce.number().int().positive().nullable(),
  }),
});

/// Admin partial-update for a partner's documents and bank info.
/// Every field is optional — caller only sends what changed. Empty
/// string clears the field; null also clears (the service treats
/// both the same so the admin form can drop empty inputs cleanly).
const updateDocumentsSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      aadharNumber: z.string().trim().max(20).nullable().optional(),
      panNumber: z.string().trim().max(20).nullable().optional(),
      dlNumber: z.string().trim().max(40).nullable().optional(),
      aadharImageUrl: z.string().trim().url().or(z.literal('')).nullable().optional(),
      panImageUrl: z.string().trim().url().or(z.literal('')).nullable().optional(),
      dlImageUrl: z.string().trim().url().or(z.literal('')).nullable().optional(),
      bankAccount: z.string().trim().max(40).nullable().optional(),
      bankIfsc: z.string().trim().max(20).nullable().optional(),
      bankPassbookUrl: z.string().trim().url().or(z.literal('')).nullable().optional(),
      signatureUrl: z.string().trim().url().or(z.literal('')).nullable().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

/// Admin in-house create. Phone is mandatory (the unique key);
/// everything else is optional so the admin can fill what they have
/// and add the rest later from the partner detail page.
const createSchema = z.object({
  body: z.object({
    /// E.164 or plain 10 digits — same regex auth.validator uses.
    phone: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number'),
    name: z.string().trim().min(1).max(100),
    email: z.string().email().max(160).optional().or(z.literal('')),
    categoryId: z.coerce.number().int().positive().optional(),
    cityId: z.coerce.number().int().positive().optional(),
    city: z.string().trim().max(80).optional(),
    /// When true, partner is created with `paymentStatus=unpaid` and
    /// `isVerified=false` so they land in the onboarding queue at
    /// the "set fee" step. Default behaviour activates immediately.
    placeInOnboarding: z.boolean().optional(),
    /// Optional document/bank fields — same shape as
    /// updateDocumentsSchema. All accept empty string (treated as
    /// "not set") to keep the form code simple.
    aadharNumber: z.string().trim().max(20).optional().or(z.literal('')),
    panNumber: z.string().trim().max(20).optional().or(z.literal('')),
    dlNumber: z.string().trim().max(40).optional().or(z.literal('')),
    aadharImageUrl: z.string().trim().url().optional().or(z.literal('')),
    panImageUrl: z.string().trim().url().optional().or(z.literal('')),
    dlImageUrl: z.string().trim().url().optional().or(z.literal('')),
    bankAccount: z.string().trim().max(40).optional().or(z.literal('')),
    bankIfsc: z.string().trim().max(20).optional().or(z.literal('')),
    bankPassbookUrl: z.string().trim().url().optional().or(z.literal('')),
    signatureUrl: z.string().trim().url().optional().or(z.literal('')),
    selfieUrl: z.string().trim().url().optional().or(z.literal('')),
  }),
});

module.exports = {
  idParam,
  listQuerySchema,
  onboardingQuerySchema,
  statusSchema,
  stageSchema,
  rejectSchema,
  onboardingFeeSchema,
  trainingStatusSchema,
  skipDlSchema,
  updateDocumentsSchema,
  updateCategorySchema,
  createSchema,
};
