const { z } = require('zod');

const captureSchema = z.object({
  body: z.object({
    /// 10-digit Indian phone (we don't enforce country code at this layer to
    /// match the OTP flow's existing shape)
    phone: z.string().trim().regex(/^\d{10,15}$/, 'Enter a valid phone number'),
    city: z.string().trim().min(1).max(80),
    pincode: z.string().trim().regex(/^\d{3,8}$/).optional(),
    source: z.string().trim().max(40).optional(),
  }),
});

const summaryQuerySchema = z.object({
  query: z.object({
    city: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

module.exports = { captureSchema, summaryQuerySchema };
