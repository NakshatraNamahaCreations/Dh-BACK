const { z } = require('zod');

const ALLOWED_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/heic',
  'application/pdf',
];

const presignSchema = z.object({
  body: z.object({
    filename: z.string().trim().min(1).max(200),
    contentType: z.enum(ALLOWED_TYPES, {
      errorMap: () => ({ message: `contentType must be one of: ${ALLOWED_TYPES.join(', ')}` }),
    }),
    size: z.number().int().min(1).max(20 * 1024 * 1024, 'Max 20 MB'),
    /** Folder hint, e.g. "categories", "partner-kyc/aadhaar". Falls
     *  back to "uploads". Forward slashes allowed so callers can nest
     *  (`partner-kyc/aadhaar`, `partner-kyc/pan`, etc.) — keeps the
     *  S3 layout audit-friendly. Each segment must still be the
     *  letters/digits/_/- allow-list. Cap raised to 80 chars to
     *  accommodate two-segment paths. */
    folder: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9_-]{1,40}(\/[a-z0-9_-]{1,40})*$/i,
        'folder may contain letters, digits, _, -, and / for nesting',
      )
      .max(80)
      .optional(),
  }),
});

module.exports = { presignSchema, ALLOWED_TYPES };
