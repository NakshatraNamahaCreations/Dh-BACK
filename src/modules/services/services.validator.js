const { z } = require('zod');

const idParam = z.object({
  params: z.object({
    id: z.coerce.number().int().positive('Invalid service id'),
  }),
});

const faqRow = z.object({
  question: z.string().trim().min(1, 'Question is required').max(200),
  answer: z.string().trim().min(1, 'Answer is required').max(2000),
});

const baseFields = {
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(500).default(''),
  imageUrl: z.string().trim().url().nullable().optional(),
  thumbnailUrl: z.string().trim().url().nullable().optional(),
  durationMins: z.number().int().min(5, 'Min 5 mins').max(600, 'Max 10 hours'),
  basePrice: z.number().int().min(0, 'Base price must be non-negative').max(10_000_000),
  originalPrice: z.number().int().min(0).max(10_000_000).nullable().optional(),
  active: z.boolean().default(true),
  includes: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  excludes: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  categoryId: z.number().int().positive('Invalid categoryId'),
  /// Optional sub-category within the category. null/omitted = attached
  /// directly to the category. Validated server-side to belong to the
  /// chosen category.
  subCategoryId: z.number().int().positive('Invalid subCategoryId').nullable().optional(),
  /// Optional list of question/answer pairs. When present in a save payload,
  /// replaces the service's existing FAQs entirely.
  faqs: z.array(faqRow).max(20).optional(),
};

const createSchema = z.object({
  body: z
    .object(baseFields)
    .refine(
      (v) => v.originalPrice == null || v.originalPrice > v.basePrice,
      { message: 'originalPrice must be greater than basePrice', path: ['originalPrice'] },
    ),
});

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: baseFields.name.optional(),
      description: baseFields.description.optional(),
      imageUrl: baseFields.imageUrl,
      thumbnailUrl: baseFields.thumbnailUrl,
      durationMins: baseFields.durationMins.optional(),
      basePrice: baseFields.basePrice.optional(),
      originalPrice: baseFields.originalPrice,
      active: z.boolean().optional(),
      includes: baseFields.includes.optional(),
      excludes: baseFields.excludes.optional(),
      categoryId: baseFields.categoryId.optional(),
      subCategoryId: baseFields.subCategoryId,
      faqs: baseFields.faqs,
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const listQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    search: z.string().trim().max(120).optional(),
    categoryId: z.coerce.number().int().positive().optional(),
    active: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => (v == null ? undefined : v === 'true')),
  }),
});

const bulkImportSchema = z.object({
  body: z.object({
    rows: z
      .array(
        z
          .object(baseFields)
          .refine(
            (v) => v.originalPrice == null || v.originalPrice > v.basePrice,
            { message: 'originalPrice must be greater than basePrice', path: ['originalPrice'] },
          ),
      )
      .min(1, 'rows must contain at least one service')
      .max(500, 'Maximum 500 rows per import'),
  }),
});

const relatedQuerySchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(20).default(6),
  }),
});

module.exports = {
  idParam,
  createSchema,
  updateSchema,
  listQuerySchema,
  bulkImportSchema,
  relatedQuerySchema,
};
