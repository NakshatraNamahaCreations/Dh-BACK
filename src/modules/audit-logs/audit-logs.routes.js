const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const { listQuerySchema } = require('./audit-logs.validator');
const controller = require('./audit-logs.controller');

const router = express.Router();
const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/', adminOnly, requirePermission('audit.view'), validate(listQuerySchema), controller.list);

module.exports = router;
