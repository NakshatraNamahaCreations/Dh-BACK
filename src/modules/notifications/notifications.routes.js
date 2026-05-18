const express = require('express');
const { authenticate, requireType } = require('../../middlewares/auth');
const controller = require('./notifications.controller');

const router = express.Router();
const partnerOnly = [authenticate, requireType('PARTNER')];

router.get('/', partnerOnly, controller.list);
router.patch('/read-all', partnerOnly, controller.markAllRead);
router.delete('/all', partnerOnly, controller.clearAll);
router.patch('/:id/read', partnerOnly, controller.markRead);
router.delete('/:id', partnerOnly, controller.remove);

module.exports = router;
