const { z } = require('zod');

const createSchema = z.object({
  body: z.object({
    reason: z
      .string()
      .trim()
      .min(5, 'Please tell us briefly why (at least 5 characters)')
      .max(1000, 'Reason is too long'),
  }),
});

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

const listQuerySchema = z.object({
  query: z.object({
    status: z.enum(['pending', 'approved', 'rejected', 'all']).optional(),
    userType: z.enum(['CUSTOMER', 'PARTNER']).optional(),
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const approveSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      adminNote: z.string().trim().max(500).optional(),
    })
    .optional(),
});

const rejectSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    adminNote: z
      .string()
      .trim()
      .min(3, 'Please add a note so the user knows why')
      .max(500),
  }),
});

module.exports = {
  createSchema,
  idParam,
  listQuerySchema,
  approveSchema,
  rejectSchema,
};
