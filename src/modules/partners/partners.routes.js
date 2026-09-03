const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  idParam,
  listQuerySchema,
  onboardingQuerySchema,
  statusSchema,
  stageSchema,
  rejectSchema,
  onboardingFeeSchema,
  trainingStatusSchema,
  skipDlSchema,
  updateDocumentsSchema,
  updateCategorySchema,
  createSchema,
} = require('./partners.validator');
const controller = require('./partners.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

// Onboarding queue routes need to come before the generic /:id route.
// RBAC keys mirror the Roles screen chips: `onboarding.approve` = the
// verification-step actions (call verified / payment marked / DL skip).
router.get('/onboarding', adminOnly, requirePermission('onboarding.view'), validate(onboardingQuerySchema), controller.listOnboarding);
router.patch('/onboarding/:id/stage', adminOnly, requirePermission('onboarding.approve'), validate(stageSchema), controller.updateStage);
router.patch('/onboarding/:id/fee', adminOnly, requirePermission('onboarding.set_fee'), validate(onboardingFeeSchema), controller.setOnboardingFee);
router.patch('/onboarding/:id/training', adminOnly, requirePermission('onboarding.set_training'), validate(trainingStatusSchema), controller.setTrainingStatus);
router.post('/onboarding/:id/dl/skip', adminOnly, requirePermission('onboarding.approve'), validate(skipDlSchema), controller.skipDlVerification);
router.post('/onboarding/:id/approve', adminOnly, requirePermission('onboarding.activate'), validate(idParam), controller.approve);
router.post('/onboarding/:id/reject', adminOnly, requirePermission('onboarding.reject'), validate(rejectSchema), controller.reject);

router.get('/', adminOnly, requirePermission('partners.view'), validate(listQuerySchema), controller.list);
router.post('/', adminOnly, requirePermission('partners.edit'), validate(createSchema), controller.create);
router.get('/:id', adminOnly, requirePermission('partners.view'), validate(idParam), controller.get);
router.patch('/:id/status', adminOnly, requirePermission('partners.suspend'), validate(statusSchema), controller.updateStatus);
router.get('/:id/status-history', adminOnly, requirePermission('partners.view'), validate(idParam), controller.statusHistory);
router.get('/:id/cancellations', adminOnly, requirePermission('partners.view'), validate(idParam), controller.cancellationHistory);
// Waive a pending cancellation penalty. Gated on the payout-settlement
// permission, not `partners.edit` — this moves money off a partner's
// balance, so it belongs with the finance actions rather than profile edits.
router.post('/:id/cancellations/:adjustmentId/waive', adminOnly, requirePermission('payouts.mark_paid'), controller.waiveAdjustment);
router.patch('/:id/documents', adminOnly, requirePermission('partners.edit'), validate(updateDocumentsSchema), controller.updateDocuments);
router.patch('/:id/category', adminOnly, requirePermission('partners.edit'), validate(updateCategorySchema), controller.updateCategory);

module.exports = router;
