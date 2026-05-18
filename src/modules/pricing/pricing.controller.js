const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./pricing.service');

// ── Suggested ranges ────────────────────────────────────────────────────────

exports.listRanges = asyncHandler(async (_req, res) => {
  const items = await service.listRanges();
  success(res, items, 'Suggested ranges fetched');
});

exports.saveRanges = asyncHandler(async (req, res) => {
  const items = await service.saveRanges(req.body.rows);
  success(res, items, 'Suggested ranges saved');
});

exports.quoteRange = asyncHandler(async (req, res) => {
  const { items, city, pincode, at } = req.body;
  const quote = await service.quoteRange({ items, city, pincode, at });
  success(res, quote, 'Range quote computed');
});

// ── Surge rules ─────────────────────────────────────────────────────────────

exports.listSurge = asyncHandler(async (_req, res) => {
  const items = await service.listSurge();
  success(res, items, 'Surge rules fetched');
});

exports.createSurge = asyncHandler(async (req, res) => {
  const item = await service.createSurge(req.body);
  created(res, item, 'Surge rule created');
});

exports.updateSurge = asyncHandler(async (req, res) => {
  const item = await service.updateSurge(req.params.id, req.body);
  success(res, item, 'Surge rule updated');
});

exports.toggleSurge = asyncHandler(async (req, res) => {
  const item = await service.toggleSurge(req.params.id);
  success(res, item, 'Surge rule toggled');
});

exports.removeSurge = asyncHandler(async (req, res) => {
  await service.removeSurge(req.params.id);
  success(res, { id: req.params.id }, 'Surge rule deleted');
});
