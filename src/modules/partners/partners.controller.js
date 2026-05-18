const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const { scopeByAdmin } = require('../../middlewares/adminScope');
const service = require('./partners.service');

exports.list = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await service.list({ ...req.query, scope });
  success(res, data, 'Partners fetched', 200, meta);
});

/// Admin in-house create — skips the partner-app OTP/onboarding flow.
exports.create = asyncHandler(async (req, res) => {
  const item = await service.create(req.body);
  success(res, item, 'Partner created', 201);
});

exports.get = asyncHandler(async (req, res) => {
  const item = await service.get(req.params.id);
  success(res, item, 'Partner fetched');
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const item = await service.updateStatus(req.params.id, req.body.status, req.body.reason);
  success(res, item, 'Partner status updated');
});

exports.updateDocuments = asyncHandler(async (req, res) => {
  const item = await service.updateDocuments(req.params.id, req.body);
  success(res, item, 'Partner documents updated');
});

exports.updateCategory = asyncHandler(async (req, res) => {
  const item = await service.updateCategory(req.params.id, req.body.categoryId);
  success(res, item, 'Partner category updated');
});

exports.listOnboarding = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await service.listOnboarding({ ...req.query, scope });
  success(res, data, 'Onboarding queue fetched', 200, meta);
});

exports.updateStage = asyncHandler(async (req, res) => {
  const item = await service.updateStage(req.params.id, req.body.stage, req.body.status, req.body.note, req.user.sub);
  success(res, item, 'Onboarding stage updated');
});

exports.approve = asyncHandler(async (req, res) => {
  const item = await service.approve(req.params.id);
  success(res, item, 'Partner approved');
});

exports.reject = asyncHandler(async (req, res) => {
  const item = await service.reject(req.params.id, req.body?.reason);
  success(res, item, 'Partner rejected');
});

exports.setOnboardingFee = asyncHandler(async (req, res) => {
  const item = await service.setOnboardingFee(req.params.id, {
    amount: Number(req.body.amount),
    note: req.body.note,
  });
  success(res, item, 'Onboarding fee saved');
});

exports.setTrainingStatus = asyncHandler(async (req, res) => {
  const item = await service.setTrainingStatus(req.params.id, {
    completed: !!req.body.completed,
  });
  success(res, item, req.body.completed ? 'Training marked complete' : 'Training reset to pending');
});
