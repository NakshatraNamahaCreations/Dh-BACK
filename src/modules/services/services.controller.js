const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./services.service');

exports.list = asyncHandler(async (req, res) => {
  const { items, page, pageSize, total, totalPages } = await service.list(req.query);
  success(res, items, 'Services fetched', 200, { page, pageSize, total, totalPages });
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(req.params.id);
  success(res, item, 'Service fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Service created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(req.params.id, req.body);
  success(res, item, 'Service updated');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(req.params.id);
  success(res, { id: req.params.id }, 'Service deleted');
});

exports.toggleActive = asyncHandler(async (req, res) => {
  const item = await service.toggleActive(req.params.id);
  success(res, item, 'Service visibility toggled');
});

exports.bulkImport = asyncHandler(async (req, res) => {
  const result = await service.bulkImport(req.body.rows);
  created(res, result, `${result.inserted} services imported`);
});

exports.getRelated = asyncHandler(async (req, res) => {
  const items = await service.getRelated(Number(req.params.id), {
    limit: Number(req.query.limit) || 6,
  });
  success(res, items, 'Related services fetched');
});
