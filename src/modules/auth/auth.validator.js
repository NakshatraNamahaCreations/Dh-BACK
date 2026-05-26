const { z } = require('zod');

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[1-9]\d{7,14}$/, 'Invalid phone number');

const codeSchema = z.string().regex(/^\d{4}$/, 'OTP must be 4 digits');

const sendOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
  }),
});

const verifyOtpSchema = z.object({
  body: z.object({
    phone: phoneSchema,
    code: codeSchema,
    name: z.string().min(1).max(100).optional(),
  }),
});

const adminLoginSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
});

const updateMeSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      email: z.string().email().max(160).optional(),
      categoryId: z.number().int().positive().optional(),
      city: z.string().trim().min(1).max(80).optional(),
      experience: z.enum(['0', '1-3', '3-5', '5-10', '10+']).optional(),
      age: z.number().int().min(18).max(80).optional(),
      gender: z.enum(['m', 'f', 'o']).optional(),
      aadharNumber: z.string().min(12).max(12).optional(),
      panNumber: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/).optional(),
      dlNumber: z.string().min(6).max(20).optional(),
      bankAccount: z.string().min(9).max(18).optional(),
      bankIfsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/).optional(),
      aadharImageUrl: z.string().url().optional(),
      aadharBackImageUrl: z.string().url().optional(),
      panImageUrl: z.string().url().optional(),
      dlImageUrl: z.string().url().optional(),
      bankPassbookUrl: z.string().url().optional(),
      selfieUrl: z.string().url().optional(),
      expoPushToken: z.string().max(200).optional(),
      /// Direct FCM device token (raw, no `ExponentPushToken[` prefix).
      /// Wider max because raw FCM tokens are ~150–200 chars on average
      /// but vendor-extended ones can run longer.
      fcmToken: z.string().max(400).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

const verifyOnboardingPaymentSchema = z.object({
  body: z.object({
    razorpayOrderId: z.string().min(1),
    razorpayPaymentId: z.string().min(1),
    razorpaySignature: z.string().min(1),
  }),
});

module.exports = {
  sendOtpSchema,
  verifyOtpSchema,
  adminLoginSchema,
  updateMeSchema,
  verifyOnboardingPaymentSchema,
};
