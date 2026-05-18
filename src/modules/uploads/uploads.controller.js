const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./uploads.service');

exports.presign = asyncHandler(async (req, res) => {
  const result = await service.presignUpload(req.body);
  success(res, result, 'Presigned upload URL ready');
});
