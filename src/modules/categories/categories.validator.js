const { z } = require('zod');

const idParam = z.object({
  params: z.object({
    id: z.coerce.number().int().positive('Invalid category id'),
  }),
});

const colorSchema = z
  .string()
  .regex(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/, 'Color must be a hex like #2F5FFF');

const baseFields = {
  name: z.string().trim().min(1, 'Name is required').max(80),
  /// `icon` was originally a short Lucide icon name (≤40 chars).
  /// Admin now uploads an actual image — its S3 URL goes into this
  /// same field. Bumped the cap to 500 so any presigned-upload URL
  /// passes validation; the customer-app detects URL vs. name and
  /// renders accordingly.
  icon: z.string().trim().min(1).max(500).default('wrench'),
  color: colorSchema.default('#2F5FFF'),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  bannerImageUrl: z.string().trim().url().nullable().optional(),
};

const createSchema = z.object({
  body: z.object(baseFields),
});

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: baseFields.name.optional(),
      icon: baseFields.icon.optional(),
      color: colorSchema.optional(),
      active: z.boolean().optional(),
      sortOrder: baseFields.sortOrder,
      bannerImageUrl: baseFields.bannerImageUrl,
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const reorderSchema = z.object({
  body: z.object({
    order: z.array(z.number().int().positive()).min(1, 'Order must be a non-empty list of category ids'),
  }),
});

const listQuerySchema = z.object({
  query: z.object({
    active: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => (v == null ? undefined : v === 'true')),
    search: z.string().trim().max(100).optional(),
  }),
});

module.exports = { createSchema, updateSchema, reorderSchema, listQuerySchema, idParam };
