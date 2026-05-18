const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  updateSchema,
  listQuerySchema,
  applySchema,
} = require('./coupons.validator');
const controller = require('./coupons.controller');

const router = express.Router();

const customerOnly = [authenticate, requireType('CUSTOMER')];
const adminOnly = [authenticate, requireType('ADMIN')];

/// Customer apply — validates a coupon against the in-flight cart and
/// returns the computed discount. Doesn't burn a redemption (that's
/// done at booking creation).
router.post('/apply', customerOnly, validate(applySchema), controller.apply);

/// Admin CRUD.
router.get('/', adminOnly, validate(listQuerySchema), controller.adminList);
router.post('/', adminOnly, validate(createSchema), controller.adminCreate);
router.get('/:id', adminOnly, validate(idParam), controller.adminGet);
router.patch('/:id', adminOnly, validate(updateSchema), controller.adminUpdate);
router.delete('/:id', adminOnly, validate(idParam), controller.adminDelete);
router.post(
  '/:id/toggle-active',
  adminOnly,
  validate(idParam),
  controller.adminToggleActive,
);

module.exports = router;
