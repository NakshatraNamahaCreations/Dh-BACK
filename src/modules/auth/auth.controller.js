const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const authService = require('./auth.service');
const razorpayService = require('../payments/razorpay.service');

exports.customerSendOtp = asyncHandler(async (req, res) => {
  const result = await authService.customerSendOtp(req.body);
  success(res, result, 'OTP sent');
});

exports.customerVerifyOtp = asyncHandler(async (req, res) => {
  const result = await authService.customerVerifyOtp(req.body);
  success(res, result, 'Logged in successfully');
});

exports.partnerSendOtp = asyncHandler(async (req, res) => {
  const result = await authService.partnerSendOtp(req.body);
  success(res, result, 'OTP sent');
});


exports.partnerVerifyOtp = asyncHandler(async (req, res) => {
  const result = await authService.partnerVerifyOtp(req.body);
  success(res, result, 'Logged in successfully');
});

exports.adminLogin = asyncHandler(async (req, res) => {
  const result = await authService.adminLogin(req.body);
  success(res, result, 'Logged in successfully');
});

exports.me = asyncHandler(async (req, res) => {
  const result = await authService.me(req.user);
  success(res, result);
});

exports.updateMe = asyncHandler(async (req, res) => {
  const result = await authService.updateMe(req.user, req.body);
  success(res, result, 'Profile updated');
});

exports.registerPushToken = asyncHandler(async (req, res) => {
  const { token } = req.body;
  await authService.registerPushToken(req.user, token);
  success(res, { ok: true });
});

exports.partnerPaymentDone = asyncHandler(async (req, res) => {
  const result = await authService.partnerPaymentDone(req.user.sub);
  success(res, result, 'Payment confirmed. Welcome to Dhoond!');
});

/// Mint a Razorpay order for the partner's onboarding fee. The amount
/// comes from Partner.onboardingFeeAmount (set by admin); the partner
/// app uses the returned order id + key id to open Razorpay Checkout.
exports.createOnboardingOrder = asyncHandler(async (req, res) => {
  const result = await razorpayService.createOnboardingOrder({
    partnerId: req.user.sub,
  });
  success(res, result, 'Order created');
});

/// Verify the signed payload Razorpay Checkout returns, then flip the
/// partner row to `paid` via the existing partnerPaymentDone path so
/// docs/call/fee guards still run.
exports.verifyOnboardingPayment = asyncHandler(async (req, res) => {
  await razorpayService.verifyOnboardingPayment({
    partnerId: req.user.sub,
    razorpayOrderId: req.body.razorpayOrderId,
    razorpayPaymentId: req.body.razorpayPaymentId,
    razorpaySignature: req.body.razorpaySignature,
  });
  const result = await authService.partnerPaymentDone(req.user.sub);
  success(res, result, 'Payment verified. Welcome to Dhoond!');
});
