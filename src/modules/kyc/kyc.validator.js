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
    /// Front-of-card image URL. Required so the backend can OCR-check
    /// the number BEFORE burning a QuickeKYC OTP credit on a partner
    /// who uploaded a non-Aadhaar photo (e.g. a screenshot, selfie, etc).
    imageUrl: imageUrlSchema,
    /// Back-of-card image URL. Backend OCR-checks for UIDAI markers
    /// (uidai.gov.in, "Unique Identification Authority", 1947 helpline)
    /// — the number isn't reliably printed on every Aadhaar back, but
    /// those strings always are.
    backImageUrl: imageUrlSchema,
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
    /// Accept either DD-MM-YYYY (what the partner-app form takes —
    /// natural for Indian date entry) or YYYY-MM-DD (the ISO form,
    /// used by admin tooling). The service normalises to YYYY-MM-DD
    /// before calling QuickeKYC, which rejects everything else with 422.
    dob: z
      .string()
      .trim()
      .regex(
        /^(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})$/,
        'Date of birth must be in DD-MM-YYYY or YYYY-MM-DD format',
      ),
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
