const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./banners.service');

exports.list = asyncHandler(async (req, res) => {
  const items = await service.list(req.query);
  success(res, items, 'Banners fetched');
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(req.params.id);
  success(res, item, 'Banner fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Banner created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(req.params.id, req.body);
  success(res, item, 'Banner updated');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(req.params.id);
  success(res, { id: req.params.id }, 'Banner deleted');
});

exports.toggleActive = asyncHandler(async (req, res) => {
  const item = await service.toggleActive(req.params.id);
  success(res, item, 'Banner visibility toggled');
});

exports.reorder = asyncHandler(async (req, res) => {
  const items = await service.reorder(req.body.placement, req.body.order);
  success(res, items, 'Banners reordered');
});
