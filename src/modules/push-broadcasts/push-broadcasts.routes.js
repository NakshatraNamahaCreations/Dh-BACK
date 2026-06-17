const express = require('express');
const { authenticate, requireType } = require('../../middlewares/auth');
const { requireRole } = require('../../middlewares/adminScope');
const controller = require('./push-broadcasts.controller');

const router = express.Router();

router.use(authenticate, requireType('ADMIN'), requireRole('SUPER'));

router.post('/', controller.send);
router.get('/', controller.list);
router.delete('/:id', controller.remove);

module.exports = router;
