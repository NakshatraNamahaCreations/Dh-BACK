const { z } = require('zod');

const cancellationSchema = z.object({
  body: z.object({
    freeWindowMins: z.number().int().min(0).max(120),
    customerTiers: z.array(
      z.object({
        fromMins: z.number().int().min(0),
        feePercent: z.number().int().min(0).max(100),
      }),
    ),
    partnerPenalty: z.number().int().min(0).max(10_000_000),
    partnerStrikeLimit: z.number().int().min(1).max(20),
  }),
});

const refundSchema = z.object({
  body: z.object({
    autoApproveBelow: z.number().int().min(0).max(10_000_000),
    manualReviewAbove: z.number().int().min(0).max(10_000_000),
    processingDaysBank: z.number().int().min(1).max(14),
    processingDaysWallet: z.number().int().min(0).max(5),
    partialRefundEnabled: z.boolean(),
    reasonRequired: z.boolean(),
  }),
});

/// Exactly 3 broadcast radii (km), each 1–50, and non-descending so the
/// widening search never shrinks (r0 ≤ r1 ≤ r2). Refined here so a bad
/// admin entry is rejected at the API rather than silently falling back.
const dispatchSchema = z.object({
  body: z.object({
    radii: z
      .array(z.number().positive().max(50))
      .length(3)
      .refine((r) => r[0] <= r[1] && r[1] <= r[2], {
        message: 'Radii must be non-descending (e.g. 3 ≤ 5 ≤ 7).',
      }),
  }),
});

module.exports = { cancellationSchema, refundSchema, dispatchSchema };
