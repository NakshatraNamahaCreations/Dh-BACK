const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.string().min(1) }),
});

// ── Commissions ────────────────────────────────────────────────────────────

const saveCommissionSchema = z.object({
  body: z.object({
    rows: z
      .array(
        z.object({
          categoryId: z.coerce.number().int().positive(),
          partnerPct: z.coerce.number().int().min(0).max(100),
        }),
      )
      .min(1),
  }),
});

// ── Earnings ───────────────────────────────────────────────────────────────

const partnerSummariesQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).optional(),
    /// Geography filter — admin's State→City cascade.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const partnerEarningsQuerySchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  query: z.object({
    status: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

// ── Payouts ────────────────────────────────────────────────────────────────

const generatePayoutSchema = z.object({
  body: z.object({
    partnerId: z.coerce.number().int().positive(),
    notes: z.string().trim().max(500).optional(),
  }),
});

const payoutListQuerySchema = z.object({
  query: z.object({
    status: z.string().optional(),
    search: z.string().trim().max(100).optional(),
    partnerId: z.coerce.number().int().positive().optional(),
    /// Geography filter — scopes payouts by Partner.cityId.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    /// Date range (inclusive) — weekly / monthly history filters.
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const approvePayoutSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({ notes: z.string().trim().max(500).optional() }).default({}),
});

const markPaidSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    reference: z.string().trim().min(1, 'Bank/UPI reference is required').max(120),
    notes: z.string().trim().max(500).optional(),
  }),
});

const rejectPayoutSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    notes: z.string().trim().min(1, 'A reason note is required').max(500),
  }),
});

// ── Ledger / Razorpay (unchanged) ───────────────────────────────────────────

const ledgerQuerySchema = z.object({
  query: z.object({
    type: z.string().optional(),
    search: z.string().trim().max(100).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    /// Geography filter — admin's State→City cascade. Resolved
    /// against the underlying booking/partner row, not the ledger
    /// row itself (the ledger is a derived view).
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    page: z.coerce.number().int().min(1).optional(),
  }),
});

const razorpayCreateOrderSchema = z.object({
  body: z.object({
    bookingId: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  }),
});

const razorpayVerifySchema = z.object({
  body: z.object({
    bookingId: z.union([z.string(), z.number()]).transform((v) => Number(v)),
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  }),
});

/// Add-on side-bill — same field shapes as the main order/verify pair.
const razorpayAddOnOrderSchema = razorpayCreateOrderSchema;
const razorpayAddOnVerifySchema = razorpayVerifySchema;
/// Active reconcile — asks the server to pull the order's true status from
/// Razorpay and settle it (webhook/redirect backstop). Body is just the id.
const razorpayReconcileSchema = razorpayCreateOrderSchema;

/// Weekly settlements — weekStart is any date inside the target week
/// (server normalises to that week's Monday).
const weeklyQuerySchema = z.object({
  query: z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD'),
    /// Geography filter — scopes rows by the partner's home city.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
  }),
});

const weeklyMarkPaidSchema = z.object({
  body: z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD'),
    /// Omitted/empty = settle EVERY partner with pending earnings that week.
    partnerIds: z.array(z.number().int().positive()).max(1000).optional(),
    /// Mirrors the UI's active State/City filter so a bulk "Mark week
    /// paid" only settles partners inside the filtered view.
    cityId: z.number().int().positive().optional(),
    stateId: z.number().int().positive().optional(),
  }),
});

/// Monthly settlement report — calendar month, accountant view.
const monthlyReportQuerySchema = z.object({
  query: z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/, 'month must be YYYY-MM'),
    /// Geography filter — scopes rows by the partner's home city.
    cityId: z.coerce.number().int().positive().optional(),
    stateId: z.coerce.number().int().positive().optional(),
  }),
});

/// Weekly remark — empty remark clears the note.
const weeklyRemarkSchema = z.object({
  body: z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'weekStart must be YYYY-MM-DD'),
    partnerId: z.number().int().positive(),
    remark: z.string().trim().max(500).optional().default(''),
  }),
});

module.exports = {
  idParam,
  saveCommissionSchema,
  partnerSummariesQuerySchema,
  partnerEarningsQuerySchema,
  generatePayoutSchema,
  payoutListQuerySchema,
  approvePayoutSchema,
  markPaidSchema,
  rejectPayoutSchema,
  ledgerQuerySchema,
  razorpayCreateOrderSchema,
  razorpayVerifySchema,
  razorpayAddOnOrderSchema,
  razorpayAddOnVerifySchema,
  razorpayReconcileSchema,
  weeklyQuerySchema,
  weeklyMarkPaidSchema,
  weeklyRemarkSchema,
  monthlyReportQuerySchema,
};
