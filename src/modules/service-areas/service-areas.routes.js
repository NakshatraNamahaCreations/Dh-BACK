const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  updateSchema,
  checkQuerySchema,
} = require('./service-areas.validator');
const controller = require('./service-areas.controller');

const router = express.Router();

// Public endpoints
router.get('/cities', controller.cities);
router.get('/check', validate(checkQuerySchema), controller.check);

// Admin-only.
const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/', adminOnly, requirePermission('areas.view'), controller.list);
router.get('/:id', adminOnly, requirePermission('areas.view'), validate(idParam), controller.get);
router.post('/', adminOnly, requirePermission('areas.create'), validate(createSchema), controller.create);
router.patch('/:id', adminOnly, requirePermission('areas.edit'), validate(updateSchema), controller.update);
router.post('/:id/toggle', adminOnly, requirePermission('areas.edit'), validate(idParam), controller.toggle);
router.delete('/:id', adminOnly, requirePermission('areas.delete'), validate(idParam), controller.remove);

module.exports = router;
