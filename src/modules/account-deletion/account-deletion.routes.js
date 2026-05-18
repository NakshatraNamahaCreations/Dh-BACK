const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const controller = require('./account-deletion.controller');
const {
  createSchema,
  idParam,
  listQuerySchema,
  approveSchema,
  rejectSchema,
} = require('./account-deletion.validator');

const router = express.Router();

const userOnly = [authenticate, requireType('CUSTOMER', 'PARTNER')];
const adminOnly = [authenticate, requireType('ADMIN')];

// ── Customer / partner facing ─────────────────────────────────────────
// `/me` routes are registered before `/:id` so the admin's numeric
// detail route doesn't try to coerce the literal "me".
router.get('/me', userOnly, controller.getMine);
router.post('/me', userOnly, validate(createSchema), controller.submit);

// ── Admin ─────────────────────────────────────────────────────────────
router.get('/', adminOnly, validate(listQuerySchema), controller.list);
router.get('/:id', adminOnly, validate(idParam), controller.get);
router.post('/:id/approve', adminOnly, validate(approveSchema), controller.approve);
router.post('/:id/reject', adminOnly, validate(rejectSchema), controller.reject);

module.exports = router;
