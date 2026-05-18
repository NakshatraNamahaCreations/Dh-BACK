const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./account-deletion.service');

/// User-facing — customer or partner submits a deletion request with
/// a free-form reason. The user type comes from the JWT, never the
/// body, so the route is the same for both.
exports.submit = asyncHandler(async (req, res) => {
  const item = await service.createRequest({
    userType: req.user.type,
    userId: req.user.sub,
    reason: req.body.reason,
  });
  created(res, item, 'Deletion request submitted');
});

exports.getMine = asyncHandler(async (req, res) => {
  const item = await service.getMine({
    userType: req.user.type,
    userId: req.user.sub,
  });
  success(res, item, 'Deletion request fetched');
});

// ── Admin ─────────────────────────────────────────────────────────────
exports.list = asyncHandler(async (req, res) => {
  const { data, meta } = await service.list(req.query);
  success(res, data, 'Deletion requests fetched', 200, meta);
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(req.params.id);
  success(res, item, 'Deletion request fetched');
});

exports.approve = asyncHandler(async (req, res) => {
  const item = await service.approve(req.params.id, {
    adminId: req.user.sub,
    adminNote: req.body?.adminNote,
  });
  success(res, item, 'Account deleted');
});

exports.reject = asyncHandler(async (req, res) => {
  const item = await service.reject(req.params.id, {
    adminId: req.user.sub,
    adminNote: req.body.adminNote,
  });
  success(res, item, 'Deletion request rejected');
});
