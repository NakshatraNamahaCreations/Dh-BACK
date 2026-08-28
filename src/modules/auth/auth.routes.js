const express = require('express');
const rateLimit = require('express-rate-limit');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  sendOtpSchema,
  verifyOtpSchema,
  adminLoginSchema,
  updateMeSchema,
  verifyOnboardingPaymentSchema,
} = require('./auth.validator');
const controller = require('./auth.controller');

const router = express.Router();

const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  /// The Play-review / internal test account must never be rate-limited:
  /// app reviewers (and our own device testing) log in with it repeatedly
  /// in short bursts, and a 429 here reads as "login is broken". It's a
  /// non-routable test number whose OTP is the fixed dev code, so the
  /// limiter adds no protection for it anyway.
  skip: (req) => req.body?.phone === '+919999900000',
  keyGenerator: (req) => req.body?.phone || req.ip,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many OTP requests. Try again later.' },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

// Customer app
router.post('/customer/send-otp', otpSendLimiter, validate(sendOtpSchema), controller.customerSendOtp);
router.post('/customer/verify-otp', loginLimiter, validate(verifyOtpSchema), controller.customerVerifyOtp);

// Partner app
router.post('/partner/send-otp', otpSendLimiter, validate(sendOtpSchema), controller.partnerSendOtp);
router.post('/partner/verify-otp', loginLimiter, validate(verifyOtpSchema), controller.partnerVerifyOtp);

// Admin panel
router.post('/admin/login', loginLimiter, validate(adminLoginSchema), controller.adminLogin);

// Partner onboarding payment — Razorpay flow.
//   1. POST /partner/onboarding/order   → mints a Razorpay order with the
//      admin-set fee and returns { orderId, keyId, amount, currency } so
//      the partner app can open Checkout.
//   2. POST /partner/onboarding/verify  → backend verifies the signed
//      payload, persists the payment id, and flips paymentStatus = paid.
// The legacy /partner/payment-done endpoint is kept for now so older app
// builds still work, but new clients should call the verify route which
// enforces signature verification.
router.post(
  '/partner/onboarding/order',
  authenticate,
  requireType('PARTNER'),
  controller.createOnboardingOrder,
);
router.post(
  '/partner/onboarding/verify',
  authenticate,
  requireType('PARTNER'),
  validate(verifyOnboardingPaymentSchema),
  controller.verifyOnboardingPayment,
);
router.post('/partner/payment-done', authenticate, requireType('PARTNER'), controller.partnerPaymentDone);

// Current user
router.get('/me', authenticate, controller.me);
router.patch('/me', authenticate, validate(updateMeSchema), controller.updateMe);

// Push token registration — called by customer and partner apps after login
router.patch('/me/push-token', authenticate, controller.registerPushToken);

module.exports = router;
