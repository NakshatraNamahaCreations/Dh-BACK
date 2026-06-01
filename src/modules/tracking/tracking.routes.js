const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const { bookingIdParam, locationBody, dutyBody } = require('./tracking.validator');
const controller = require('./tracking.controller');

const router = express.Router();

const partnerOnly = [authenticate, requireType('PARTNER')];
const customerOnly = [authenticate, requireType('CUSTOMER')];

// Partner pushes its current GPS while it has an active accepted booking.
// Service rejects with 400 when the partner has no active booking, so the
// partner-app can stop posting (saves battery) and use that as a signal
// the job is done.
router.post('/me/location', partnerOnly, validate(locationBody), controller.postLocation);

// Partner toggles On Duty / Off Duty. This is the authoritative duty
// signal: going off duty sets a Redis guard flag and pulls the partner
// out of the dispatch pool immediately, so a socket reconnect after a
// location change can no longer silently re-register them as available.
router.post('/me/duty', partnerOnly, validate(dutyBody), controller.setDuty);

// Customer reads the assigned partner's last-known location for their
// booking. Returns nulls when the booking isn't in a live state — the
// client treats that as "stop polling".
router.get(
  '/bookings/:id',
  customerOnly,
  validate(bookingIdParam),
  controller.getForBooking,
);

module.exports = router;
