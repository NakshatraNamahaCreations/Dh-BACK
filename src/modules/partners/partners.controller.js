const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const { scopeByAdmin, assertInScope } = require('../../middlewares/adminScope');
const prisma = require('../../config/prisma');
const service = require('./partners.service');

/// Guard a single-partner detail/mutation request against the admin's
/// city scope. SUPER admins pass straight through (scope.cityIds == null);
/// a CITY_MANAGER may only touch partners in their assigned cities.
/// Partners carry a direct `cityId`, so one cheap lookup answers it.
/// Throws 403 (via assertInScope) when out of scope. Must run BEFORE the
/// service mutation so a scoped admin can't modify a partner outside their
/// cities by guessing the id.
const ensurePartnerInScope = async (req) => {
  const scope = await scopeByAdmin(req);
  if (scope.cityIds == null) return; // SUPER / unscoped — skip the lookup
  const partner = await prisma.partner.findUnique({
    where: { id: Number(req.params.id) },
    select: { cityId: true },
  });
  /// A missing partner is left for the service layer to 404; we only
  /// enforce scope when the row exists.
  if (!partner) return;
  assertInScope(scope, [partner.cityId]);
};

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
  await ensurePartnerInScope(req);
  const item = await service.get(req.params.id);
  success(res, item, 'Partner fetched');
});

exports.updateStatus = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.updateStatus(req.params.id, req.body.status, req.body.reason);
  success(res, item, 'Partner status updated');
});

exports.updateDocuments = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.updateDocuments(req.params.id, req.body);
  success(res, item, 'Partner documents updated');
});

exports.updateCategory = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
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
  await ensurePartnerInScope(req);
  const item = await service.updateStage(req.params.id, req.body.stage, req.body.status, req.body.note, req.user.sub);
  success(res, item, 'Onboarding stage updated');
});

exports.approve = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.approve(req.params.id);
  success(res, item, 'Partner approved');
});

exports.reject = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.reject(req.params.id, req.body?.reason);
  success(res, item, 'Partner rejected');
});

exports.setOnboardingFee = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.setOnboardingFee(req.params.id, {
    amount: Number(req.body.amount),
    note: req.body.note,
  });
  success(res, item, 'Onboarding fee saved');
});

exports.setTrainingStatus = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.setTrainingStatus(req.params.id, {
    completed: !!req.body.completed,
  });
  success(res, item, req.body.completed ? 'Training marked complete' : 'Training reset to pending');
});

exports.skipDlVerification = asyncHandler(async (req, res) => {
  await ensurePartnerInScope(req);
  const item = await service.skipDlVerification(req.params.id, req.body?.reason, req.user.sub);
  success(res, item, 'Driving license verification skipped');
});
