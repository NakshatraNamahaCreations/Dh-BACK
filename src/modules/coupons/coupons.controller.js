const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./coupons.service');

// ── Customer ───────────────────────────────────────────────────────────

exports.apply = asyncHandler(async (req, res) => {
  const data = await service.applyForCart({
    code: req.body.code,
    items: req.body.items,
  });
  success(res, data, 'Coupon applied');
});

exports.listAvailable = asyncHandler(async (req, res) => {
  const data = await service.listAvailable();
  success(res, data, 'Coupons fetched');
});

// ── Admin ──────────────────────────────────────────────────────────────

exports.adminList = asyncHandler(async (req, res) => {
  const { data, meta } = await service.adminList(req.query);
  success(res, data, 'Coupons fetched', 200, meta);
});

exports.adminGet = asyncHandler(async (req, res) => {
  const item = await service.adminGet(req.params.id);
  success(res, item, 'Coupon fetched');
});

exports.adminCreate = asyncHandler(async (req, res) => {
  const item = await service.adminCreate(req.body);
  success(res, item, 'Coupon created', 201);
});

exports.adminUpdate = asyncHandler(async (req, res) => {
  const item = await service.adminUpdate(req.params.id, req.body);
  success(res, item, 'Coupon updated');
});

exports.adminDelete = asyncHandler(async (req, res) => {
  await service.adminDelete(req.params.id);
  success(res, null, 'Coupon deleted');
});

exports.adminToggleActive = asyncHandler(async (req, res) => {
  const item = await service.adminToggleActive(req.params.id);
  success(res, item, item.active ? 'Coupon activated' : 'Coupon deactivated');
});
