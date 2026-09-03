const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(5000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  /// Customer sessions are deliberately decoupled from JWT_EXPIRES_IN
  /// (which also governs admin/partner tokens). A customer's session
  /// SLIDES: /auth/me re-issues a fresh token once the current one is
  /// over a day old, so an active customer is never logged out — this
  /// window only bites someone who hasn't opened the app at all for
  /// this long. Previously every customer was hard-logged-out
  /// JWT_EXPIRES_IN after login regardless of activity.
  CUSTOMER_JWT_EXPIRES_IN: z.string().default('30d'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),
  OTP_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  OTP_RESEND_SECONDS: z.coerce.number().int().min(10).max(600).default(60),

  // ── Store-review test accounts ─────────────────────────────────────
  // Comma-separated phone numbers (any format — only the last 10 digits
  // are compared) that BYPASS the SMS gateway and always accept
  // TEST_OTP_CODE as their OTP. This lets Google Play / App Store
  // reviewers sign in to our OTP-only login without a real SMS, and the
  // code is surfaced on the OTP screen even in production. Leave
  // TEST_OTP_CODE empty to disable entirely. NEVER list a real user's
  // number here.
  TEST_OTP_PHONES: z.string().default(''),
  TEST_OTP_CODE: z.string().default(''),

  // Razorpay. Keys are optional at boot so non-payment dev/CI tasks can
  // still run; payment endpoints fail clearly if the needed key is absent.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Redis is OPTIONAL. When unset the cache layer turns into a no-op so
  // dev / CI machines don't need a running Redis. Set to a redis://...
  // URL in any environment where you actually want caching.
  REDIS_URL: z.string().url().optional(),
  // Default TTL (in seconds) for cached read endpoints. Per-call overrides
  // are still possible — this is just the catalog default.
  REDIS_TTL_SECONDS: z.coerce.number().int().min(1).max(86400).default(300),
  // ── Dispatch worker mode ───────────────────────────────────────────
  // 'embedded' — API process also runs the BullMQ dispatch worker (the
  //   default; right for single-box deploys).
  // 'standalone' — API process does NOT run the worker, expecting a
  //   separate `npm run worker` process to consume the queue. Right
  //   for multi-box deploys where the worker scales independently.
  DISPATCH_WORKER_MODE: z.enum(['embedded', 'standalone']).default('embedded'),

  // ── SMS provider (yourbulksms.com) — used to deliver OTPs to both
  // customers and partners. When SMS_AUTHKEY is unset we fall back to
  // logging the OTP to the server console (dev-only).
  SMS_AUTHKEY: z.string().optional(),
  SMS_SENDER_ID: z.string().default('DHOOND'),
  SMS_DLT_TEMPLATE_ID: z.string().optional(),
  SMS_API_URL: z.string().url().default('http://control.yourbulksms.com/api/sendhttp.php'),
  SMS_ROUTE: z.coerce.number().int().default(2),
  SMS_COUNTRY: z.coerce.number().int().default(0),

  // S3 / object storage — optional. If unset, the uploads module returns
  // an explanatory error instead of crashing on boot.
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Optional CDN base, e.g. https://cdn.dhoond.in */
  S3_PUBLIC_BASE_URL: z.string().url().optional(),
  /** Force path-style URLs (needed for MinIO / non-AWS providers). */
  S3_FORCE_PATH_STYLE: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
  /** Custom endpoint for non-AWS S3 providers (MinIO, Cloudflare R2, etc.) */
  S3_ENDPOINT: z.string().url().optional(),

  // ── Email (SMTP) — used for invoice delivery after payment. When unset,
  // invoice emails are skipped with a warning log (safe for dev/CI).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('noreply@dhoond.in'),

  // ── Company / GST details printed on customer invoices ────────────────
  COMPANY_NAME: z.string().default('Dhoond Services'),
  COMPANY_ADDRESS: z.string().default('Bengaluru, Karnataka 560001, India'),
  COMPANY_GSTIN: z.string().optional(),

  // ── QuickeKYC — third-party Aadhaar / PAN / DL verification used
  // during partner onboarding. The token is sent in the request
  // body as `key`. When unset, the /kyc routes return a clear "not
  // configured" error so dev/CI environments that don't need KYC
  // don't have to provide credentials.
  QUICKEKYC_API_TOKEN: z.string().optional(),
  QUICKEKYC_BASE_URL: z.string().url().default('https://api.quickekyc.com'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

module.exports = parsed.data;
