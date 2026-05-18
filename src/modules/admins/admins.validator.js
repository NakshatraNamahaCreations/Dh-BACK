const { z } = require('zod');

const listQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(100).optional(),
    role: z.enum(['SUPER', 'CITY_MANAGER']).optional(),
    status: z.enum(['active', 'inactive']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

const createSchema = z.object({
  body: z.object({
    email: z.string().email().max(160),
    password: z.string().min(8, 'Password must be at least 8 characters').max(100),
    name: z.string().trim().max(100).optional(),
    role: z.enum(['SUPER', 'CITY_MANAGER']),
    cityIds: z.array(z.coerce.number().int().positive()).optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: z.string().trim().max(100).optional(),
      role: z.enum(['SUPER', 'CITY_MANAGER']).optional(),
      isActive: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const setCitiesSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    cityIds: z.array(z.coerce.number().int().positive()),
  }),
});

const resetPasswordSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    password: z.string().min(8).max(100),
  }),
});

/// Self-service password change — distinct from `resetPasswordSchema`
/// (which is the SUPER-only override). Here the caller must prove
/// they know the current password before setting a new one, and the
/// `id` comes from the JWT, not the URL.
const changeOwnPasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required').max(100),
    newPassword: z
      .string()
      .min(8, 'New password must be at least 8 characters')
      .max(100),
  }),
});

module.exports = {
  listQuerySchema,
  idParam,
  createSchema,
  updateSchema,
  setCitiesSchema,
  resetPasswordSchema,
  changeOwnPasswordSchema,
};
