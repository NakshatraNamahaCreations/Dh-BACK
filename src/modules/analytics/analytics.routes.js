const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { rangeQuerySchema, customerRangeQuerySchema, bookingReportQuerySchema } = require('./analytics.validator');
const controller = require('./analytics.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];

router.get('/summary', adminOnly, controller.summary);
router.get('/revenue/series', adminOnly, validate(rangeQuerySchema), controller.revenueSeries);
router.get('/bookings', adminOnly, validate(rangeQuerySchema), controller.bookings);
router.get('/revenue', adminOnly, validate(rangeQuerySchema), controller.revenue);
router.get('/partners', adminOnly, validate(rangeQuerySchema), controller.partners);
router.get('/customers', adminOnly, validate(customerRangeQuerySchema), controller.customers);
router.get('/booking-report', adminOnly, validate(bookingReportQuerySchema), controller.bookingReport);

module.exports = router;
