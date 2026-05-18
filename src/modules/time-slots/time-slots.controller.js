const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./time-slots.service');

exports.list = asyncHandler(async (req, res) => {
  const items = await service.list({ activeOnly: req.query.activeOnly });
  success(res, items, 'Time slots fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Time slot created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(Number(req.params.id), req.body);
  success(res, item, 'Time slot updated');
});

exports.toggle = asyncHandler(async (req, res) => {
  const item = await service.toggle(Number(req.params.id));
  success(res, item, 'Time slot toggled');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(Number(req.params.id));
  success(res, { id: Number(req.params.id) }, 'Time slot deleted');
});
