const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive('Invalid id') }),
});

const timeStr = z.string().regex(/^\d{2}:\d{2}$/, 'Time must be HH:mm');

const baseFields = {
  label: z.string().trim().min(1).max(40),
  startTime: timeStr,
  endTime: timeStr,
  capacity: z.number().int().min(0).max(10000),
  icon: z.string().trim().max(40).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  active: z.boolean().optional(),
};

const createSchema = z.object({
  body: z.object(baseFields),
});

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      label: baseFields.label.optional(),
      startTime: timeStr.optional(),
      endTime: timeStr.optional(),
      capacity: baseFields.capacity.optional(),
      icon: baseFields.icon,
      sortOrder: baseFields.sortOrder,
      active: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const listQuerySchema = z.object({
  query: z.object({
    activeOnly: z
      .union([z.literal('true'), z.literal('false'), z.boolean()])
      .optional()
      .transform((v) => v === true || v === 'true'),
  }),
});

module.exports = { idParam, createSchema, updateSchema, listQuerySchema };
