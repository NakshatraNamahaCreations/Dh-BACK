const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
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

router.post('/', adminOnly, validate(createSchema), controller.create);
router.patch('/:id', adminOnly, validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, validate(idParam), controller.remove);
router.post('/:id/toggle', adminOnly, validate(idParam), controller.toggleActive);
router.post('/reorder', adminOnly, validate(reorderSchema), controller.reorder);

module.exports = router;
