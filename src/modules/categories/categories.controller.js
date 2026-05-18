const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./categories.service');

exports.list = asyncHandler(async (req, res) => {
  const items = await service.list(req.query);
  success(res, items, 'Categories fetched');
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(req.params.id);
  success(res, item, 'Category fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Category created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(req.params.id, req.body);
  success(res, item, 'Category updated');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(req.params.id);
  success(res, { id: req.params.id }, 'Category deleted');
});

exports.toggleActive = asyncHandler(async (req, res) => {
  const item = await service.toggleActive(req.params.id);
  success(res, item, 'Category visibility toggled');
});

exports.reorder = asyncHandler(async (req, res) => {
  const items = await service.reorder(req.body.order);
  success(res, items, 'Categories reordered');
});
