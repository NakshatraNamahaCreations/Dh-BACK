const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./policy.service');

exports.getCancellation = asyncHandler(async (_req, res) => {
  const data = await service.getCancellation();
  success(res, data, 'Cancellation policy fetched');
});

exports.saveCancellation = asyncHandler(async (req, res) => {
  const data = await service.saveCancellation(req.body);
  success(res, data, 'Cancellation policy saved');
});

exports.getRefund = asyncHandler(async (_req, res) => {
  const data = await service.getRefund();
  success(res, data, 'Refund policy fetched');
});

exports.saveRefund = asyncHandler(async (req, res) => {
  const data = await service.saveRefund(req.body);
  success(res, data, 'Refund policy saved');
});
