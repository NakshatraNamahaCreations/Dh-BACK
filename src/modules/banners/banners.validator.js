const { z } = require('zod');

const idParam = z.object({
  params: z.object({
    id: z.coerce.number().int().positive('Invalid banner id'),
  }),
});

const placementSchema = z.enum(['HOME_HERO', 'SPOTLIGHT']);
const ctaTypeSchema = z.enum(['NONE', 'CATEGORY', 'SERVICE', 'URL']);

const baseFields = {
  placement: placementSchema,
  imageUrl: z.string().trim().url().nullable().optional(),
  ctaType: ctaTypeSchema.default('NONE'),
  ctaValue: z.string().trim().max(500).nullable().optional(),
  ctaLabel: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  startsAt: z
    .union([z.string().datetime(), z.string().length(0), z.null()])
    .optional()
    .transform((v) => (v && v.length ? new Date(v) : null)),
  endsAt: z
    .union([z.string().datetime(), z.string().length(0), z.null()])
    .optional()
    .transform((v) => (v && v.length ? new Date(v) : null)),
};

const ctaRefinement = (v) => {
  if (v.ctaType === 'NONE') return true;
  return Boolean(v.ctaValue && v.ctaValue.length > 0);
};
const ctaError = {
  message: 'ctaValue is required when ctaType is not NONE',
  path: ['ctaValue'],
};

const dateRefinement = (v) => {
  if (!v.startsAt || !v.endsAt) return true;
  return v.startsAt < v.endsAt;
};
const dateError = {
  message: 'endsAt must be after startsAt',
  path: ['endsAt'],
};

const createSchema = z.object({
  body: z.object(baseFields).refine(ctaRefinement, ctaError).refine(dateRefinement, dateError),
});

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      placement: baseFields.placement.optional(),
      imageUrl: baseFields.imageUrl,
      ctaType: baseFields.ctaType.optional(),
      ctaValue: baseFields.ctaValue,
      ctaLabel: baseFields.ctaLabel,
      active: z.boolean().optional(),
      sortOrder: baseFields.sortOrder,
      startsAt: baseFields.startsAt,
      endsAt: baseFields.endsAt,
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const reorderSchema = z.object({
  body: z.object({
    placement: placementSchema,
    order: z.array(z.number().int().positive()).min(1, 'order must be a non-empty list of banner ids'),
  }),
});

const listQuerySchema = z.object({
  query: z.object({
    placement: placementSchema.optional(),
    active: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => (v == null ? undefined : v === 'true')),
    /** Public clients pass `liveOnly=true` to get only currently-active scheduled banners. */
    liveOnly: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => v === 'true'),
  }),
});

module.exports = { createSchema, updateSchema, reorderSchema, listQuerySchema, idParam };
