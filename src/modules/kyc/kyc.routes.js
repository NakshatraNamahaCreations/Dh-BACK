const express = require('express');
const rateLimit = require('express-rate-limit');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const controller = require('./kyc.controller');
const {
  generateAadhaarOtpSchema,
  submitAadhaarOtpSchema,
  saveAadhaarPhotosSchema,
  verifyPanSchema,
  verifyDlSchema,
  verifyBankSchema,
  skipSchema,
} = require('./kyc.validator');

const router = express.Router();

const partnerOnly = [authenticate, requireType('PARTNER')];

/// Tight rate-limit on OTP generation — each partner can ask for at
/// most 5 Aadhaar OTPs in 10 minutes. QuickeKYC charges per call, so
/// this also protects spend.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Try again in a few minutes.' },
});

router.post(
  '/aadhaar/generate-otp',
  partnerOnly,
  otpLimiter,
  validate(generateAadhaarOtpSchema),
  controller.generateAadhaarOtp,
);
router.post(
  '/aadhaar/submit-otp',
  partnerOnly,
  validate(submitAadhaarOtpSchema),
  controller.submitAadhaarOtp,
);
router.post(
  '/aadhaar/photos',
  partnerOnly,
  validate(saveAadhaarPhotosSchema),
  controller.saveAadhaarPhotos,
);
router.post('/pan/verify', partnerOnly, validate(verifyPanSchema), controller.verifyPan);
router.post('/dl/verify', partnerOnly, validate(verifyDlSchema), controller.verifyDl);
router.post('/bank/verify', partnerOnly, validate(verifyBankSchema), controller.verifyBank);
/// Partner self-skip of PAN / DL during onboarding (no QuickeKYC call).
router.post('/pan/skip', partnerOnly, validate(skipSchema), controller.skipPan);
router.post('/dl/skip', partnerOnly, validate(skipSchema), controller.skipDl);

module.exports = router;
