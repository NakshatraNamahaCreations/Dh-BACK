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
/// before login). `?app=customer|partner&platform=android|ios`.
///
/// Older shipped builds don't send `platform`, so fall back to sniffing
/// the User-Agent: React Native's iOS fetch stack identifies itself with
/// CFNetwork/Darwin, Android with okhttp. This lets ALREADY-INSTALLED
/// iOS builds receive the App Store URL without an app update.
exports.getAppConfig = asyncHandler(async (req, res) => {
  let platform = req.query.platform;
  if (!platform) {
    const ua = String(req.headers['user-agent'] ?? '');
    if (/CFNetwork|Darwin|iPhone|iPad|iOS/i.test(ua)) platform = 'ios';
  }
  const data = await service.getAppConfig(req.query.app, platform);
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

exports.getCompany = asyncHandler(async (_req, res) => {
  success(res, await service.getCompanyDetails(), 'Company details fetched');
});

exports.saveCompany = asyncHandler(async (req, res) => {
  success(res, await service.saveCompanyDetails(req.body), 'Company details saved');
});
