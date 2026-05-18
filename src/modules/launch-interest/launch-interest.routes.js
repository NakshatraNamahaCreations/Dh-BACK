const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { captureSchema, summaryQuerySchema } = require('./launch-interest.validator');
const controller = require('./launch-interest.controller');

const router = express.Router();

// Public — submitted from the customer-app "Coming soon" screen.
router.post('/', validate(captureSchema), controller.capture);

// Admin demand view.
router.get(
  '/',
  authenticate,
  requireType('ADMIN'),
  validate(summaryQuerySchema),
  controller.summary,
);

module.exports = router;
