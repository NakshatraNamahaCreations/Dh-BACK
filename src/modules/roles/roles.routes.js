const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { idParam, createSchema, updateSchema } = require('./roles.validator');
const controller = require('./roles.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/', adminOnly, controller.list);
router.post('/', adminOnly, validate(createSchema), controller.create);
router.patch('/:id', adminOnly, validate(updateSchema), controller.update);
router.delete('/:id', adminOnly, validate(idParam), controller.remove);

module.exports = router;
