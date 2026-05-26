const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const ApiError = require('../../utils/ApiError');
const prisma = require('../../config/prisma');
const service = require('./kyc.service');

/**
 * Admin-side KYC controllers — mirror `kyc.controller.js` but read
 * `partnerId` from the URL path instead of `req.user.sub`. Used by
 * the admin's "Create partner (in-house)" wizard so admins can run
 * the same QuickeKYC verification flow on behalf of a partner who
 * is sitting next to them (admin enters the Aadhaar OTP the partner
 * reads aloud from their SMS, etc.).
 *
 * Every handler resolves `partnerId` from `req.params.partnerId`,
 * validates the row exists, then calls the same service functions
 * the partner-side controller uses — so KYC business logic stays
 * single-sourced and any future change (provider swap, validation
 * tweak) automatically applies to both flows.
 */

/// Light guard — kicks an obvious 404 before we hit QuickeKYC and
/// burn an API credit on a row that doesn't exist. Returns the
/// `Number()`-coerced partnerId so handlers can use it directly.
const requirePartner = async (rawId) => {
  const partnerId = Number(rawId);
  if (!Number.isFinite(partnerId) || partnerId <= 0) {
    throw ApiError.badRequest('Invalid partner id');
  }
  const exists = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: { id: true },
  });
  if (!exists) throw ApiError.notFound('Partner not found');
  return partnerId;
};

exports.generateAadhaarOtp = asyncHandler(async (req, res) => {
  const partnerId = await requirePartner(req.params.partnerId);
  const result = await service.generateAadhaarOtp({
    partnerId,
    aadhaarNumber: req.body.aadhaarNumber,
    imageUrl: req.body.imageUrl,
    backImageUrl: req.body.backImageUrl,
  });
  success(res, result, 'OTP sent to partner\'s Aadhaar-linked mobile.');
});

exports.saveAadhaarPhotos = asyncHandler(async (req, res) => {
  const partnerId = await requirePartner(req.params.partnerId);
  const result = await service.saveAadhaarPhotos({
    partnerId,
    imageUrl: req.body.imageUrl,
    backImageUrl: req.body.backImageUrl,
  });
  success(res, result, 'Aadhaar photos saved.');
});

exports.submitAadhaarOtp = asyncHandler(async (req, res) => {
  const partnerId = await requirePartner(req.params.partnerId);
  const result = await service.submitAadhaarOtp({
    partnerId,
    requestId: req.body.requestId,
    otp: req.body.otp,
  });
  success(res, result, 'Aadhaar verified.');
});

exports.verifyPan = asyncHandler(async (req, res) => {
  const partnerId = await requirePartner(req.params.partnerId);
  const result = await service.verifyPan({
    partnerId,
    panNumber: req.body.panNumber,
    imageUrl: req.body.imageUrl,
  });
  success(res, result, 'PAN verified.');
});

exports.verifyDl = asyncHandler(async (req, res) => {
  const partnerId = await requirePartner(req.params.partnerId);
  const result = await service.verifyDrivingLicense({
    partnerId,
    dlNumber: req.body.dlNumber,
    dob: req.body.dob,
    imageUrl: req.body.imageUrl,
  });
  success(res, result, 'Driving license verified.');
});

exports.verifyBank = asyncHandler(async (req, res) => {
  const partnerId = await requirePartner(req.params.partnerId);
  const result = await service.verifyBankAccount({
    partnerId,
    accountNumber: req.body.accountNumber,
    ifsc: req.body.ifsc,
    imageUrl: req.body.imageUrl,
  });
  success(res, result, 'Bank account verified.');
});
