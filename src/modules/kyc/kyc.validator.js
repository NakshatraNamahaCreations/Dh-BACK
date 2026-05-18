const { z } = require('zod');

/// `imageUrl` is the S3 URL the partner-app uploaded for the
/// document photo. Required at onboarding so admin always has
/// a card scan on file alongside the verified API result.
/// `.url()` rejects obvious garbage; the backend trusts the rest
/// because the partner only gets this URL by first calling
/// `/uploads/presign` with their JWT.
const imageUrlSchema = z
  .string()
  .trim()
  .url('Document photo upload missing or invalid');

const generateAadhaarOtpSchema = z.object({
  body: z.object({
    aadhaarNumber: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s/g, ''))
      .refine((s) => /^\d{12}$/.test(s), 'Aadhaar must be 12 digits'),
  }),
});

/// Photos arrive AFTER OTP verification — saves an S3 upload on
/// abandoned attempts where the partner never finishes verifying.
/// Both URLs are required here since the actual onboarding flow only
/// hits this endpoint with both captured.
const saveAadhaarPhotosSchema = z.object({
  body: z.object({
    imageUrl: imageUrlSchema,
    backImageUrl: imageUrlSchema,
  }),
});

const submitAadhaarOtpSchema = z.object({
  body: z.object({
    requestId: z.string().trim().min(1, 'requestId is required'),
    otp: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, 'OTP must be 4–8 digits'),
  }),
});

const verifyPanSchema = z.object({
  body: z.object({
    panNumber: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/\s/g, ''))
      .refine((s) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s), 'PAN must be in ABCDE1234F format'),
    imageUrl: imageUrlSchema,
  }),
});

const verifyDlSchema = z.object({
  body: z.object({
    dlNumber: z
      .string()
      .trim()
      .min(5, 'Driving license number is too short')
      .max(30),
    /// YYYY-MM-DD; QuickeKYC rejects other formats with 422.
    dob: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format'),
    imageUrl: imageUrlSchema,
  }),
});

const verifyBankSchema = z.object({
  body: z.object({
    accountNumber: z
      .string()
      .trim()
      .transform((s) => s.replace(/\s/g, ''))
      .refine((s) => /^\d{6,20}$/.test(s), 'Account number must be 6-20 digits'),
    ifsc: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase().replace(/\s/g, ''))
      .refine((s) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s), 'IFSC must follow ABCD0XXXXXX format'),
    imageUrl: imageUrlSchema,
  }),
});

module.exports = {
  generateAadhaarOtpSchema,
  submitAadhaarOtpSchema,
  saveAadhaarPhotosSchema,
  verifyPanSchema,
  verifyDlSchema,
  verifyBankSchema,
};
