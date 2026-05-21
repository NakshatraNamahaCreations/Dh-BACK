const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
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
router.get('/onboarding', adminOnly, validate(onboardingQuerySchema), controller.listOnboarding);
router.patch('/onboarding/:id/stage', adminOnly, validate(stageSchema), controller.updateStage);
router.patch('/onboarding/:id/fee', adminOnly, validate(onboardingFeeSchema), controller.setOnboardingFee);
router.patch('/onboarding/:id/training', adminOnly, validate(trainingStatusSchema), controller.setTrainingStatus);
router.post('/onboarding/:id/dl/skip', adminOnly, validate(skipDlSchema), controller.skipDlVerification);
router.post('/onboarding/:id/approve', adminOnly, validate(idParam), controller.approve);
router.post('/onboarding/:id/reject', adminOnly, validate(rejectSchema), controller.reject);

router.get('/', adminOnly, validate(listQuerySchema), controller.list);
router.post('/', adminOnly, validate(createSchema), controller.create);
router.get('/:id', adminOnly, validate(idParam), controller.get);
router.patch('/:id/status', adminOnly, validate(statusSchema), controller.updateStatus);
router.patch('/:id/documents', adminOnly, validate(updateDocumentsSchema), controller.updateDocuments);
router.patch('/:id/category', adminOnly, validate(updateCategorySchema), controller.updateCategory);

module.exports = router;
