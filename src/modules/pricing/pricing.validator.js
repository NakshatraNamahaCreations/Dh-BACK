const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive('Invalid id') }),
});

const saveRangesSchema = z.object({
  body: z.object({
    rows: z
      .array(
        z.object({
          categoryId: z.number().int().positive(),
          /// percentages, 0..1000 to allow extreme spreads if ever needed
          minPct: z.number().int().min(0).max(1000),
          midPct: z.number().int().min(0).max(1000),
          maxPct: z.number().int().min(0).max(1000),
        }),
      )
      .min(1, 'rows must contain at least one entry'),
  }),
});

/// Customer cart → aggregated slider bounds. Optionally accepts location and
/// time so the backend can surface an applicable surge multiplier.
const quoteRangeSchema = z.object({
  body: z.object({
    items: z
      .array(
        z.object({
          serviceId: z.coerce.number().int().positive(),
          qty: z.coerce.number().int().min(1).max(99),
        }),
      )
      .min(1, 'items must contain at least one entry')
      .max(50, 'too many items'),
    /// city + pincode the customer is booking for — required for surge match
    city: z.string().trim().max(80).optional(),
    pincode: z.string().trim().regex(/^\d{3,8}$/).optional(),
    /// ISO timestamp; defaults to "now" if omitted
    at: z.string().datetime().optional(),
  }),
});

const dayEnum = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const timeStr = z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:mm');
const pincodeArr = z.array(z.string().trim().regex(/^\d{3,8}$/)).max(200);

const surgeFields = {
  name: z.string().trim().min(1).max(100),
  /// null = applies to all categories, otherwise a Category id
  categoryId: z.number().int().positive().nullable(),
  serviceAreaId: z.number().int().positive(),
  /// optional subset within the service area; empty = whole area
  pincodes: pincodeArr.optional(),
  days: z.array(dayEnum).min(1, 'Select at least one day'),
  startTime: timeStr,
  endTime: timeStr,
  multiplier: z.number().min(1.0).max(5.0),
  active: z.boolean().default(true),
};

const createSurgeSchema = z.object({ body: z.object(surgeFields) });

const updateSurgeSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: surgeFields.name.optional(),
      categoryId: surgeFields.categoryId.optional(),
      serviceAreaId: surgeFields.serviceAreaId.optional(),
      pincodes: pincodeArr.optional(),
      days: surgeFields.days.optional(),
      startTime: timeStr.optional(),
      endTime: timeStr.optional(),
      multiplier: surgeFields.multiplier.optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

module.exports = {
  idParam,
  saveRangesSchema,
  quoteRangeSchema,
  createSurgeSchema,
  updateSurgeSchema,
};
