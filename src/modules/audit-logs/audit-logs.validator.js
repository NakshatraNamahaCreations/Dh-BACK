const { z } = require('zod');

const listQuerySchema = z.object({
  query: z.object({
    adminId: z.coerce.number().int().positive().optional(),
    module: z.string().trim().max(80).optional(),
    action: z.string().trim().max(80).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  }),
});

module.exports = { listQuerySchema };
