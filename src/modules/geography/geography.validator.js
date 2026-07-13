const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
});

const listCitiesQuerySchema = z.object({
  query: z.object({
    stateId: z.coerce.number().int().positive().optional(),
    search: z.string().trim().max(100).optional(),
    active: z
      .union([z.literal('true'), z.literal('false')])
      .optional()
      .transform((v) => (v == null ? undefined : v === 'true')),
  }),
});

const createStateSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(80),
    code: z.string().trim().max(8).optional(),
  }),
});

const updateStateSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      code: z.string().trim().max(8).nullable().optional(),
      active: z.boolean().optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const createCitySchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(80),
    stateId: z.coerce.number().int().positive(),
    lat: z.coerce.number().optional(),
    lng: z.coerce.number().optional(),
    launchedAt: z.string().datetime().optional(),
  }),
});

const updateCitySchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      stateId: z.coerce.number().int().positive().optional(),
      lat: z.coerce.number().nullable().optional(),
      lng: z.coerce.number().nullable().optional(),
      active: z.boolean().optional(),
      launchedAt: z.union([z.string().datetime(), z.null()]).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

/// Google Places proxy (admin "Create job" address search).
const placesSearchQuerySchema = z.object({
  query: z.object({
    q: z.string().trim().min(2, 'Type at least 2 characters').max(120),
  }),
});

const placeDetailsQuerySchema = z.object({
  query: z.object({
    placeId: z.string().trim().min(5).max(300),
  }),
});

module.exports = {
  idParam,
  listCitiesQuerySchema,
  createStateSchema,
  updateStateSchema,
  createCitySchema,
  updateCitySchema,
  placesSearchQuerySchema,
  placeDetailsQuerySchema,
};
