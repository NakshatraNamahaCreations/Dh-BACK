const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
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

router.get('/', adminOnly, controller.list);
router.get('/:id', adminOnly, validate(idParam), controller.get);
router.post('/', adminOnly, validate(createSchema), controller.create);
router.patch('/:id', adminOnly, validate(updateSchema), controller.update);
router.post('/:id/toggle', adminOnly, validate(idParam), controller.toggle);
router.delete('/:id', adminOnly, validate(idParam), controller.remove);

module.exports = router;
