const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  updateSchema,
  listQuerySchema,
  bulkImportSchema,
  relatedQuerySchema,
} = require('./services.validator');
const controller = require('./services.controller');

const router = express.Router();

// Public — customer + partner apps fetch the live catalog.
router.get('/', validate(listQuerySchema), controller.list);
router.get('/:id', validate(idParam), controller.get);
router.get('/:id/related', validate(relatedQuerySchema), controller.getRelated);

// Admin-only mutations
const adminOnly = [authenticate, requireType('ADMIN')];

router.post('/', adminOnly, validate(createSchema), controller.create);
router.patch('/:id', adminOnly, validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, validate(idParam), controller.remove);
router.post('/:id/toggle', adminOnly, validate(idParam), controller.toggleActive);
router.post('/bulk', adminOnly, validate(bulkImportSchema), controller.bulkImport);

module.exports = router;
