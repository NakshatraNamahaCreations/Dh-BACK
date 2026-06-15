const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  createSchema,
  updateSchema,
  reorderSchema,
  listQuerySchema,
  idParam,
} = require('./sub-categories.validator');
const controller = require('./sub-categories.controller');

const router = express.Router();

// Public list — used by customer app for the grouped category view.
router.get('/', validate(listQuerySchema), controller.list);
router.get('/:id', validate(idParam), controller.get);

// Admin-only mutations
const adminOnly = [authenticate, requireType('ADMIN')];

router.post('/', adminOnly, validate(createSchema), controller.create);
router.patch('/:id', adminOnly, validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, validate(idParam), controller.remove);
router.post('/:id/toggle', adminOnly, validate(idParam), controller.toggleActive);
router.post('/reorder', adminOnly, validate(reorderSchema), controller.reorder);

module.exports = router;
