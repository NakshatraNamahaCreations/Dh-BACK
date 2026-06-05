const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./kyc.service');

exports.generateAadhaarOtp = asyncHandler(async (req, res) => {
  const result = await service.generateAadhaarOtp({
    partnerId: req.user.sub,
    aadhaarNumber: req.body.aadhaarNumber,
    imageUrl: req.body.imageUrl,
    backImageUrl: req.body.backImageUrl,
  });
  success(res, result, 'OTP sent to your Aadhaar-linked mobile.');
});

exports.saveAadhaarPhotos = asyncHandler(async (req, res) => {
  const result = await service.saveAadhaarPhotos({
    partnerId: req.user.sub,
    imageUrl: req.body.imageUrl,
    backImageUrl: req.body.backImageUrl,
  });
  success(res, result, 'Aadhaar photos saved.');
});

exports.submitAadhaarOtp = asyncHandler(async (req, res) => {
  const result = await service.submitAadhaarOtp({
    partnerId: req.user.sub,
    requestId: req.body.requestId,
    otp: req.body.otp,
  });
  success(res, result, 'Aadhaar verified.');
});

exports.verifyPan = asyncHandler(async (req, res) => {
  const result = await service.verifyPan({
    partnerId: req.user.sub,
    panNumber: req.body.panNumber,
    imageUrl: req.body.imageUrl,
  });
  success(res, result, 'PAN verified.');
});

exports.verifyDl = asyncHandler(async (req, res) => {
  const result = await service.verifyDrivingLicense({
    partnerId: req.user.sub,
    dlNumber: req.body.dlNumber,
    dob: req.body.dob,
    imageUrl: req.body.imageUrl,
  });
  success(res, result, 'Driving license verified.');
});

exports.verifyBank = asyncHandler(async (req, res) => {
  const result = await service.verifyBankAccount({
    partnerId: req.user.sub,
    accountNumber: req.body.accountNumber,
    ifsc: req.body.ifsc,
    imageUrl: req.body.imageUrl,
  });
  success(res, result, 'Bank account verified.');
});

exports.skipPan = asyncHandler(async (req, res) => {
  const result = await service.skipPan({ partnerId: req.user.sub, reason: req.body?.reason });
  success(res, result, 'PAN skipped. You can add it later from your profile.');
});

exports.skipDl = asyncHandler(async (req, res) => {
  const result = await service.skipDl({ partnerId: req.user.sub, reason: req.body?.reason });
  success(res, result, 'Driving license skipped. You can add it later from your profile.');
});
