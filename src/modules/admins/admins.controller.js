const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./admins.service');

exports.list = asyncHandler(async (req, res) => {
  const { data, meta } = await service.list(req.query);
  success(res, data, 'Admins fetched', 200, meta);
});

exports.get = asyncHandler(async (req, res) => {
  const data = await service.get(req.params.id);
  success(res, data, 'Admin fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const data = await service.create(req.body);
  created(res, data, 'Admin created');
});

exports.update = asyncHandler(async (req, res) => {
  const data = await service.update(req.params.id, req.body);
  success(res, data, 'Admin updated');
});

exports.remove = asyncHandler(async (req, res) => {
  /// `req.user.sub` is the caller's own id — the service blocks
  /// self-deletion and last-super-admin deletion.
  const data = await service.remove(req.params.id, { actingAdminId: req.user.sub });
  success(res, data, 'Admin deleted');
});

exports.setCities = asyncHandler(async (req, res) => {
  const data = await service.setCities(req.params.id, req.body.cityIds);
  success(res, data, 'Cities updated');
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const data = await service.resetPassword(req.params.id, req.body.password);
  success(res, data, 'Password reset');
});

exports.changeOwnPassword = asyncHandler(async (req, res) => {
  /// `req.user.sub` is the admin id stamped on the JWT at login —
  /// always the caller's own id, never trusted from the request body.
  const data = await service.changeOwnPassword(
    req.user.sub,
    req.body.currentPassword,
    req.body.newPassword,
  );
  success(res, data, 'Password changed');
});
