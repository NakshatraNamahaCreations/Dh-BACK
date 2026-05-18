const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./service-areas.service');

exports.list = asyncHandler(async (_req, res) => {
  const items = await service.list();
  success(res, items, 'Service areas fetched');
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(Number(req.params.id));
  success(res, item, 'Service area fetched');
});

exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  created(res, item, 'Service area created');
});

exports.update = asyncHandler(async (req, res) => {
  const item = await service.update(Number(req.params.id), req.body);
  success(res, item, 'Service area updated');
});

exports.toggle = asyncHandler(async (req, res) => {
  const item = await service.toggle(Number(req.params.id));
  success(res, item, 'Service area toggled');
});

exports.remove = asyncHandler(async (req, res) => {
  await service.remove(Number(req.params.id));
  success(res, { id: Number(req.params.id) }, 'Service area deleted');
});

exports.cities = asyncHandler(async (_req, res) => {
  const items = await service.cities();
  success(res, items, 'Cities fetched');
});

exports.check = asyncHandler(async (req, res) => {
  const result = await service.check(req.query);
  success(res, result, 'Coverage check complete');
});
