const { z } = require('zod');

const rangeQuerySchema = z.object({
  query: z.object({
    range: z.enum(['7d', '30d', '90d']).optional(),
  }),
});

const customerRangeQuerySchema = z.object({
  query: z.object({
    range: z.enum(['30d', '90d', '180d']).optional(),
  }),
});

module.exports = { rangeQuerySchema, customerRangeQuerySchema };
