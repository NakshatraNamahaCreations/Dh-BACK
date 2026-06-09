const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const { scopeByAdmin } = require('../../middlewares/adminScope');
const service = require('./customers.service');

exports.list = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await service.list({ ...req.query, scope });
  success(res, data, 'Customers fetched', 200, meta);
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(Number(req.params.id));
  success(res, item, 'Customer fetched');
});

exports.toggleActive = asyncHandler(async (req, res) => {
  const item = await service.toggleActive(Number(req.params.id));
  success(res, item, 'Customer status updated');
});

// ── Customer-facing saved addresses ────────────────────────────────────────

exports.listMyAddresses = asyncHandler(async (req, res) => {
  const items = await service.listAddresses(req.user.sub);
  success(res, items, 'Addresses fetched');
});

exports.createMyAddress = asyncHandler(async (req, res) => {
  const item = await service.createAddress(req.user.sub, req.body);
  created(res, item, 'Address saved');
});

exports.updateMyAddress = asyncHandler(async (req, res) => {
  const item = await service.updateAddress(req.user.sub, req.params.id, req.body);
  success(res, item, 'Address updated');
});

exports.deleteMyAddress = asyncHandler(async (req, res) => {
  const result = await service.deleteAddress(req.user.sub, req.params.id);
  success(res, result, 'Address removed');
});

exports.setMyDefaultAddress = asyncHandler(async (req, res) => {
  const item = await service.setDefaultAddress(req.user.sub, req.params.id);
  success(res, item, 'Default address updated');
});
