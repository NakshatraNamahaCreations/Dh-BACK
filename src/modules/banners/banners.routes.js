const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  createSchema,
  updateSchema,
  reorderSchema,
  listQuerySchema,
  idParam,
} = require('./banners.validator');
const controller = require('./banners.controller');

const router = express.Router();

// Public list — customer / partner apps fetch live banners.
//   GET /banners?placement=HOME_HERO&liveOnly=true
router.get('/', validate(listQuerySchema), controller.list);
router.get('/:id', validate(idParam), controller.get);

const adminOnly = [authenticate, requireType('ADMIN')];

router.post('/', adminOnly, requirePermission('banners.create'), validate(createSchema), controller.create);
router.patch('/:id', adminOnly, requirePermission('banners.edit'), validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, requirePermission('banners.delete'), validate(idParam), controller.remove);
router.post('/:id/toggle', adminOnly, requirePermission('banners.edit'), validate(idParam), controller.toggleActive);
router.post('/reorder', adminOnly, requirePermission('banners.edit'), validate(reorderSchema), controller.reorder);

module.exports = router;
