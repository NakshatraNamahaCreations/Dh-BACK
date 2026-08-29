const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  createSchema,
  updateSchema,
  reorderSchema,
  listQuerySchema,
  idParam,
} = require('./categories.validator');
const controller = require('./categories.controller');

const router = express.Router();

// Public list — used by customer + partner apps for the category grid.
router.get('/', validate(listQuerySchema), controller.list);
router.get('/:id', validate(idParam), controller.get);

// Admin-only mutations
const adminOnly = [authenticate, requireType('ADMIN')];

router.post('/', adminOnly, requirePermission('categories.create'), validate(createSchema), controller.create);
router.patch('/:id', adminOnly, requirePermission('categories.edit'), validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, requirePermission('categories.delete'), validate(idParam), controller.remove);
router.post('/:id/toggle', adminOnly, requirePermission('categories.edit'), validate(idParam), controller.toggleActive);
router.post('/reorder', adminOnly, requirePermission('categories.edit'), validate(reorderSchema), controller.reorder);

module.exports = router;
