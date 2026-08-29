const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
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

/// Customer — list all currently-claimable coupons (active + in-window +
/// not used up). Registered BEFORE the admin `/:id` route so the literal
/// path isn't captured as an id.
router.get('/available', customerOnly, controller.listAvailable);

/// Admin CRUD — RBAC-gated per action so a role without (e.g.)
/// `coupons.delete` gets a 403 here even though the button rendered.
router.get('/', adminOnly, requirePermission('coupons.view'), validate(listQuerySchema), controller.adminList);
router.post('/', adminOnly, requirePermission('coupons.create'), validate(createSchema), controller.adminCreate);
router.get('/:id', adminOnly, requirePermission('coupons.view'), validate(idParam), controller.adminGet);
router.patch('/:id', adminOnly, requirePermission('coupons.edit'), validate(updateSchema), controller.adminUpdate);
router.delete('/:id', adminOnly, requirePermission('coupons.delete'), validate(idParam), controller.adminDelete);
router.post(
  '/:id/toggle-active',
  adminOnly,
  requirePermission('coupons.edit'),
  validate(idParam),
  controller.adminToggleActive,
);

module.exports = router;
