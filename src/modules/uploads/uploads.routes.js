const express = require('express');
const rateLimit = require('express-rate-limit');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { presignSchema } = require('./uploads.validator');
const controller = require('./uploads.controller');

const router = express.Router();

// Defensive — admins shouldn't be hammering presign in a tight loop.
const presignLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// Admins (banner/category images) and Partners (KYC documents) both need presign.
router.post(
  '/presign',
  authenticate,
  presignLimiter,
  validate(presignSchema),
  controller.presign,
);

module.exports = router;
