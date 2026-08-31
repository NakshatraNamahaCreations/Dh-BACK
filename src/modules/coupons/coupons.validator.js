const { z } = require('zod');

/// Coupon code: 3-30 chars, alphanumeric + dash + underscore. We
/// uppercase at the service layer, but the regex stays case-insensitive
/// here so users can type either way without seeing a confusing
/// validation error.
const codeRegex = /^[a-zA-Z0-9_-]{3,30}$/;

const couponBodySchema = z
  .object({
    code: z.string().regex(codeRegex, 'Code must be 3-30 letters/digits'),
    description: z.string().max(200).optional().nullable(),
    discountType: z.enum(['PERCENT', 'FLAT']),
    /// Dual-meaning field: a PERCENT coupon stores a percentage (1-100),
    /// a FLAT coupon stores rupees.
    discountValue: z.coerce.number().int().min(1, 'Discount must be at least 1'),
    minOrderValue: z.coerce.number().int().min(0).optional(),
    maxDiscount: z.coerce.number().int().min(1).optional().nullable(),
    validFrom: z.string().datetime().optional().nullable(),
    validUntil: z.string().datetime().optional().nullable(),
    usageLimit: z.coerce.number().int().min(1).optional().nullable(),
    /// Per-customer cap — distinct from `usageLimit` (the platform-wide
    /// total). Null/omitted = unlimited per customer.
    perUserLimit: z.coerce.number().int().min(1).optional().nullable(),
    active: z.boolean().optional(),
  })
  .refine((v) => v.discountType !== 'PERCENT' || v.discountValue <= 100, {
    message: 'Percentage discount cannot exceed 100',
    path: ['discountValue'],
  });

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

const createSchema = z.object({ body: couponBodySchema });

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: couponBodySchema,
});

const listQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['all', 'active', 'inactive']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const applySchema = z.object({
  body: z.object({
    code: z.string().regex(codeRegex, 'Invalid coupon code'),
    items: z
      .array(
        z.object({
          serviceId: z.coerce.number().int().positive(),
          qty: z.coerce.number().int().min(1).max(20),
        }),
      )
      .min(1, 'Cart cannot be empty'),
  }),
});

module.exports = {
  idParam,
  createSchema,
  updateSchema,
  listQuerySchema,
  applySchema,
};
