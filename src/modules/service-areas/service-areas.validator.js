const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive('Invalid id') }),
});

const cityField = z.string().trim().min(1, 'City is required').max(80);
const stateField = z.string().trim().max(80).optional().nullable();
const pincodesField = z.array(z.string().trim().regex(/^\d{3,8}$/, 'Pincode must be digits')).max(500);
/// How to read a non-empty `pincodes` list:
///   'whitelist' — only those pincodes are served (default / legacy)
///   'extra'     — the whole city PLUS those pincodes
const pincodeModeField = z.enum(['whitelist', 'extra']);
const categoryIdsField = z.array(z.number().int().positive()).max(50);

const createSchema = z.object({
  body: z.object({
    city: cityField,
    state: stateField,
    pincodes: pincodesField.optional(),
    pincodeMode: pincodeModeField.optional(),
    categoryIds: categoryIdsField.optional(),
    active: z.boolean().optional(),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      city: cityField.optional(),
      state: stateField,
      pincodes: pincodesField.optional(),
      pincodeMode: pincodeModeField.optional(),
    pincodeMode: pincodeModeField.optional(),
      categoryIds: categoryIdsField.optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const checkQuerySchema = z.object({
  query: z
    .object({
      city: z.string().trim().max(80).optional(),
      pincode: z.string().trim().regex(/^\d{3,8}$/).optional(),
    })
    .refine((v) => Boolean(v.city || v.pincode), {
      message: 'City or pincode is required',
    }),
});

module.exports = {
  idParam,
  createSchema,
  updateSchema,
  checkQuerySchema,
};
