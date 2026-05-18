const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./launch-interest.service');

exports.capture = asyncHandler(async (req, res) => {
  const item = await service.capture(req.body);
  created(res, item, 'Got it — we\'ll let you know when we launch.');
});

exports.summary = asyncHandler(async (req, res) => {
  const result = await service.summary(req.query);
  success(res, result, 'Launch demand summary');
});
