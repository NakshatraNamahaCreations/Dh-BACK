const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { cancellationSchema, refundSchema } = require('./policy.validator');
const controller = require('./policy.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/cancellation', adminOnly, controller.getCancellation);
router.put('/cancellation', adminOnly, validate(cancellationSchema), controller.saveCancellation);

router.get('/refund', adminOnly, controller.getRefund);
router.put('/refund', adminOnly, validate(refundSchema), controller.saveRefund);

module.exports = router;
