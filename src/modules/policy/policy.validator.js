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

module.exports = { cancellationSchema, refundSchema };
