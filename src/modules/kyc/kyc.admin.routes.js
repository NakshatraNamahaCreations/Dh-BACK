const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const controller = require('./kyc.admin.controller');
const {
  generateAadhaarOtpSchema,
  submitAadhaarOtpSchema,
  saveAadhaarPhotosSchema,
  verifyPanSchema,
  verifyDlSchema,
  verifyBankSchema,
} = require('./kyc.validator');

/// Admin-side KYC routes. Mounted under `/partners/:partnerId/kyc/*`
/// so the URL structure mirrors REST conventions (resource → sub-resource).
/// All require admin auth; the controller layer pulls `partnerId` from
/// the URL and delegates to the same kyc.service the partner-side
/// flow uses, so verification logic stays single-sourced.
///
/// We deliberately DON'T apply the OTP rate-limiter that the partner
/// route uses — admins are authenticated trusted users running the
/// in-house onboarding flow, not anonymous traffic. The rate limit
/// was there to protect partner-side abuse from a stolen/leaked
/// token, which doesn't apply to admin sessions.

const router = express.Router({ mergeParams: true });
const adminOnly = [authenticate, requireType('ADMIN')];

router.post(
  '/aadhaar/generate-otp',
  adminOnly,
  validate(generateAadhaarOtpSchema),
  controller.generateAadhaarOtp,
);
router.post(
  '/aadhaar/submit-otp',
  adminOnly,
  validate(submitAadhaarOtpSchema),
  controller.submitAadhaarOtp,
);
router.post(
  '/aadhaar/photos',
  adminOnly,
  validate(saveAadhaarPhotosSchema),
  controller.saveAadhaarPhotos,
);
router.post('/pan/verify', adminOnly, validate(verifyPanSchema), controller.verifyPan);
router.post('/dl/verify', adminOnly, validate(verifyDlSchema), controller.verifyDl);
router.post('/bank/verify', adminOnly, validate(verifyBankSchema), controller.verifyBank);

module.exports = router;
