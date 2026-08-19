const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const { cancellationSchema, refundSchema, dispatchSchema, appVersionsSchema, companySchema } = require('./policy.validator');
const controller = require('./policy.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/cancellation', adminOnly, requirePermission('policy.view'), controller.getCancellation);
router.put('/cancellation', adminOnly, requirePermission('cancellation.edit'), validate(cancellationSchema), controller.saveCancellation);

router.get('/refund', adminOnly, requirePermission('policy.view'), controller.getRefund);
router.put('/refund', adminOnly, requirePermission('refund.edit'), validate(refundSchema), controller.saveRefund);

router.get('/dispatch', adminOnly, requirePermission('policy.view'), controller.getDispatch);
router.put('/dispatch', adminOnly, requirePermission('policy.edit'), validate(dispatchSchema), controller.saveDispatch);

router.get('/app-versions', adminOnly, requirePermission('policy.view'), controller.getAppVersions);
router.put('/app-versions', adminOnly, requirePermission('policy.edit'), validate(appVersionsSchema), controller.saveAppVersions);

/// Company / GST details shown on invoices (+ signatory image).
router.get('/company', adminOnly, requirePermission('policy.view'), controller.getCompany);
router.put('/company', adminOnly, requirePermission('policy.edit'), validate(companySchema), controller.saveCompany);

module.exports = router;
