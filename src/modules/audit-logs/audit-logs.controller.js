const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./audit-logs.service');

exports.list = asyncHandler(async (req, res) => {
  const { data, meta } = await service.list(req.query);
  success(res, data, 'Audit logs fetched', 200, meta);
});
