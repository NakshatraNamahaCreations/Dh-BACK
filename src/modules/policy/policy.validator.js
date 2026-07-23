const { z } = require('zod');

const cancellationSchema = z.object({
  body: z.object({
    freeWindowMins: z.number().int().min(0).max(120),
    customerTiers: z.array(
      z.object({
        fromMins: z.number().int().min(0),
        feePercent: z.number().int().min(0).max(100),
      }),
    ),
    partnerPenalty: z.number().int().min(0).max(10_000_000),
    partnerStrikeLimit: z.number().int().min(1).max(20),
  }),
});

const refundSchema = z.object({
  body: z.object({
    autoApproveBelow: z.number().int().min(0).max(10_000_000),
    manualReviewAbove: z.number().int().min(0).max(10_000_000),
    processingDaysBank: z.number().int().min(1).max(14),
    processingDaysWallet: z.number().int().min(0).max(5),
    partialRefundEnabled: z.boolean(),
    reasonRequired: z.boolean(),
  }),
});

/// Exactly 3 broadcast radii (km), each 1–50, and non-descending so the
/// widening search never shrinks (r0 ≤ r1 ≤ r2). Refined here so a bad
/// admin entry is rejected at the API rather than silently falling back.
const dispatchSchema = z.object({
  body: z.object({
    radii: z
      .array(z.number().positive().max(50))
      .length(3)
      .refine((r) => r[0] <= r[1] && r[1] <= r[2], {
        message: 'Radii must be non-descending (e.g. 3 ≤ 5 ≤ 7).',
      }),
  }),
});

/// App-version config per app. Versions are dotted semver-ish strings
/// (e.g. "1.2.0"); the apps compare them numerically part-by-part.
const semver = z
  .string()
  .trim()
  .regex(/^\d+(\.\d+){0,3}$/, 'Version must be like 1.2.0');
const appBlock = z.object({
  /// Android (Play Store) — the historical base fields, kept flat for
  /// backward compatibility with existing saved blobs.
  latestVersion: semver,
  minVersion: semver,
  storeUrl: z.string().trim().url(),
  message: z.string().trim().max(300).optional().default(''),
  /// iOS (App Store) — optional overrides. iOS releases version and ship
  /// on their own cadence, so they carry their own version pair + store
  /// URL. Absent → iOS falls back to the Android values (pre-iOS-launch
  /// behaviour).
  ios: z
    .object({
      latestVersion: semver,
      minVersion: semver,
      storeUrl: z.string().trim().url(),
    })
    .optional(),
});
const appVersionsSchema = z.object({
  body: z.object({
    customer: appBlock,
    partner: appBlock,
  }),
});

module.exports = { cancellationSchema, refundSchema, dispatchSchema, appVersionsSchema };
