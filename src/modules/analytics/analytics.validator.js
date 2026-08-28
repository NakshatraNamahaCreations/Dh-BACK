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

/// Booking report filters. All optional — an unfiltered call returns the
/// last 30 days. `from`/`to` are ISO date strings (YYYY-MM-DD); when present
/// they override `range`. Numeric ids arrive as query strings, so coerce.
const bookingReportQuerySchema = z.object({
  query: z.object({
    range: z.enum(['7d', '30d', '90d', '180d']).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    stateId: z.coerce.number().int().positive().optional(),
    cityId: z.coerce.number().int().positive().optional(),
    customerId: z.coerce.number().int().positive().optional(),
    partnerId: z.coerce.number().int().positive().optional(),
    status: z
      .enum(['PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'])
      .optional(),
    /// 'true' re-includes never-paid cancelled bookings (abandoned
    /// checkout attempts), which the report hides by default.
    includeAbandoned: z.enum(['true', 'false']).optional(),
  }),
});

module.exports = { rangeQuerySchema, customerRangeQuerySchema, bookingReportQuerySchema };
