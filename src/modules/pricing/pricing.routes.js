const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  idParam,
  saveRangesSchema,
  quoteRangeSchema,
  createSurgeSchema,
  updateSurgeSchema,
} = require('./pricing.validator');
const controller = require('./pricing.controller');

const router = express.Router();

// Admin reads & writes — one row per category with min/mid/max percentages.
router.get('/ranges', controller.listRanges);

// Public — customer cart asks for the aggregated slider bounds across its line items.
router.post('/ranges/quote', validate(quoteRangeSchema), controller.quoteRange);

// Admin-only writes.
const adminOnly = [authenticate, requireType('ADMIN')];

router.put('/ranges', adminOnly, requirePermission('pricing.edit'), validate(saveRangesSchema), controller.saveRanges);

router.get('/surge', adminOnly, requirePermission('surge.view'), controller.listSurge);
router.post('/surge', adminOnly, requirePermission('surge.create'), validate(createSurgeSchema), controller.createSurge);
router.patch('/surge/:id', adminOnly, requirePermission('surge.edit'), validate(updateSurgeSchema), controller.updateSurge);
router.post('/surge/:id/toggle', adminOnly, requirePermission('surge.edit'), validate(idParam), controller.toggleSurge);
router.delete('/surge/:id', adminOnly, requirePermission('surge.delete'), validate(idParam), controller.removeSurge);

module.exports = router;
