const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./sub-categories.service');

exports.list = asyncHandler(async (req, res) => {
  const items = await service.list(req.query);
  success(res, items, 'Sub-categories fetched');
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(req.params.id);
  success(res, item, 'Sub-category fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Sub-category created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(req.params.id, req.body);
  success(res, item, 'Sub-category updated');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(req.params.id);
  success(res, { id: req.params.id }, 'Sub-category deleted');
});

exports.toggleActive = asyncHandler(async (req, res) => {
  const item = await service.toggleActive(req.params.id);
  success(res, item, 'Sub-category visibility toggled');
});

exports.reorder = asyncHandler(async (req, res) => {
  const items = await service.reorder(req.body.categoryId, req.body.order);
  success(res, items, 'Sub-categories reordered');
});
