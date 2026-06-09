const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  idParam,
  listQuerySchema,
  createAddressSchema,
  updateAddressSchema,
  addressIdParam,
} = require('./customers.validator');
const controller = require('./customers.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];
const customerOnly = [authenticate, requireType('CUSTOMER')];

// ── Customer-facing saved addresses ─────────────────────────────────────────
// Registered BEFORE the admin /:id route so Express doesn't attempt to
// coerce "me" into a numeric id (which would 400 in the validator).
router.get('/me/addresses', customerOnly, controller.listMyAddresses);
router.post('/me/addresses', customerOnly, validate(createAddressSchema), controller.createMyAddress);
router.patch(
  '/me/addresses/:id',
  customerOnly,
  validate(updateAddressSchema),
  controller.updateMyAddress,
);
router.delete(
  '/me/addresses/:id',
  customerOnly,
  validate(addressIdParam),
  controller.deleteMyAddress,
);
router.post(
  '/me/addresses/:id/default',
  customerOnly,
  validate(addressIdParam),
  controller.setMyDefaultAddress,
);

// ── Admin ──────────────────────────────────────────────────────────────────
router.get('/', adminOnly, validate(listQuerySchema), controller.list);
router.get('/:id', adminOnly, validate(idParam), controller.get);
router.post('/:id/toggle', adminOnly, validate(idParam), controller.toggleActive);

module.exports = router;
