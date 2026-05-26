const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const { idParam, createSchema, updateSchema } = require('./roles.validator');
const controller = require('./roles.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/', adminOnly, requirePermission('roles.view'), controller.list);
router.post('/', adminOnly, requirePermission('roles.create'), validate(createSchema), controller.create);
router.patch('/:id', adminOnly, requirePermission('roles.edit'), validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, requirePermission('roles.delete'), validate(idParam), controller.remove);

module.exports = router;
