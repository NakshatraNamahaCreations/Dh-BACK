const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./roles.service');

exports.list = asyncHandler(async (_req, res) => {
  const items = await service.list();
  success(res, items, 'Roles fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Role created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(req.params.id, req.body);
  success(res, item, 'Role updated');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(req.params.id);
  success(res, { id: req.params.id }, 'Role deleted');
});
