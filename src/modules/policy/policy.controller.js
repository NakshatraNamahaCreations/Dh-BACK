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

exports.getDispatch = asyncHandler(async (_req, res) => {
  const data = await service.getDispatch();
  success(res, data, 'Dispatch config fetched');
});

exports.saveDispatch = asyncHandler(async (req, res) => {
  const data = await service.saveDispatch(req.body);
  success(res, data, 'Dispatch config saved');
});

/// PUBLIC — the launching app fetches its update config (no auth; called
/// before login). `?app=customer|partner`.
exports.getAppConfig = asyncHandler(async (req, res) => {
  const data = await service.getAppConfig(req.query.app);
  success(res, data, 'App config fetched');
});

/// Admin editor — full both-apps config.
exports.getAppVersions = asyncHandler(async (_req, res) => {
  const data = await service.getAppVersions();
  success(res, data, 'App versions fetched');
});

exports.saveAppVersions = asyncHandler(async (req, res) => {
  const data = await service.saveAppVersions(req.body);
  success(res, data, 'App versions saved');
});
