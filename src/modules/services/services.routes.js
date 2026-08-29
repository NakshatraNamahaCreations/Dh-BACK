const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  updateSchema,
  listQuerySchema,
  bulkImportSchema,
  relatedQuerySchema,
  popularQuerySchema,
} = require('./services.validator');
const controller = require('./services.controller');

const router = express.Router();

// Public — customer + partner apps fetch the live catalog.
router.get('/', validate(listQuerySchema), controller.list);
// `/popular` MUST precede `/:id` or the param route captures "popular".
router.get('/popular', validate(popularQuerySchema), controller.listPopular);
router.get('/:id', validate(idParam), controller.get);
router.get('/:id/related', validate(relatedQuerySchema), controller.getRelated);

// Admin-only mutations
const adminOnly = [authenticate, requireType('ADMIN')];

router.post('/', adminOnly, requirePermission('services.create'), validate(createSchema), controller.create);
router.patch('/:id', adminOnly, requirePermission('services.edit'), validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, requirePermission('services.delete'), validate(idParam), controller.remove);
router.post('/:id/toggle', adminOnly, requirePermission('services.edit'), validate(idParam), controller.toggleActive);
router.post('/bulk', adminOnly, requirePermission('services.create'), validate(bulkImportSchema), controller.bulkImport);

module.exports = router;
