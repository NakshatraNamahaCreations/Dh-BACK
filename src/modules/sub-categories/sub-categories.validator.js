const { z } = require('zod');

const idParam = z.object({
  params: z.object({
    id: z.coerce.number().int().positive('Invalid sub-category id'),
  }),
});

const baseFields = {
  name: z.string().trim().min(1, 'Name is required').max(80),
  categoryId: z.coerce.number().int().positive('A parent category is required'),
  /// Lucide icon name or an uploaded image URL (same dual use as Category.icon).
  icon: z.string().trim().min(1).max(500).default('wrench'),
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
      /// Parent category may be changed, but stays required-if-present.
      categoryId: baseFields.categoryId.optional(),
      icon: baseFields.icon.optional(),
      active: z.boolean().optional(),
      sortOrder: baseFields.sortOrder,
      bannerImageUrl: baseFields.bannerImageUrl,
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const reorderSchema = z.object({
  body: z.object({
    /// Reorder is scoped to one parent category so sortOrder stays
    /// meaningful within the category's sub-category list.
    categoryId: z.coerce.number().int().positive(),
    order: z
      .array(z.number().int().positive())
      .min(1, 'Order must be a non-empty list of sub-category ids'),
  }),
});

const listQuerySchema = z.object({
  query: z.object({
    /// Filter to one parent category (the admin module + service form
    /// both load sub-categories per selected category).
    categoryId: z.coerce.number().int().positive().optional(),
    active: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => (v == null ? undefined : v === 'true')),
    search: z.string().trim().max(100).optional(),
  }),
});

module.exports = { createSchema, updateSchema, reorderSchema, listQuerySchema, idParam };
