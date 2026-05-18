const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  updateSchema,
  listQuerySchema,
} = require('./time-slots.validator');
const controller = require('./time-slots.controller');

const router = express.Router();

// Public list — used by the customer app to populate the slot picker.
// `activeOnly=true` filters to live slots only.
router.get('/', validate(listQuerySchema), controller.list);

// Admin-only writes.
const adminOnly = [authenticate, requireType('ADMIN')];

router.post('/', adminOnly, validate(createSchema), controller.create);
router.patch('/:id', adminOnly, validate(updateSchema), controller.update);
router.post('/:id/toggle', adminOnly, validate(idParam), controller.toggle);
router.delete('/:id', adminOnly, validate(idParam), controller.remove);

module.exports = router;
