const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  listMineQuerySchema,
  cancelSchema,
  adminListQuerySchema,
  disputesListQuerySchema,
  resolveDisputeSchema,
  disputeNoteSchema,
  dispatchSchema,
  adminStatusSchema,
  adminCancelSchema,
  adminMarkPaidSchema,
  adminRescheduleSchema,
  partnerIncomingQuerySchema,
  partnerStatusSchema,
  partnerMineQuerySchema,
  rateBookingSchema,
} = require('./bookings.validator');
const controller = require('./bookings.controller');

const router = express.Router();

const customerOnly = [authenticate, requireType('CUSTOMER')];
const adminOnly = [authenticate, requireType('ADMIN')];
const partnerOnly = [authenticate, requireType('PARTNER')];

// ── Partner routes (before /:id catch-alls) ──────────────────────────────────
router.get('/partner/incoming', partnerOnly, validate(partnerIncomingQuerySchema), controller.partnerIncoming);
router.get('/partner/mine', partnerOnly, validate(partnerMineQuerySchema), controller.partnerMine);
router.post('/partner/:id/accept', partnerOnly, validate(idParam), controller.partnerAccept);
router.post('/partner/:id/status', partnerOnly, validate(partnerStatusSchema), controller.partnerUpdateStatus);

// ── Admin routes (registered before customer-scoped routes so /admin and
//    /live etc. don't collide with the catch-all /:id) ─────────────────────
router.get('/admin', adminOnly, validate(adminListQuerySchema), controller.adminList);
router.get('/live', adminOnly, controller.liveJobs);
router.get('/disputes', adminOnly, validate(disputesListQuerySchema), controller.listDisputes);
router.post('/disputes/:id/resolve', adminOnly, validate(resolveDisputeSchema), controller.resolveDispute);
router.post('/disputes/:id/notes', adminOnly, validate(disputeNoteSchema), controller.addDisputeNote);
router.get('/stuck', adminOnly, controller.listStuckJobs);
router.get('/admin/:id', adminOnly, validate(idParam), controller.adminGet);
router.patch('/admin/:id/status', adminOnly, validate(adminStatusSchema), controller.adminUpdateStatus);
router.post('/admin/:id/cancel', adminOnly, validate(adminCancelSchema), controller.adminCancel);
router.post('/admin/:id/mark-paid', adminOnly, validate(adminMarkPaidSchema), controller.adminMarkPaid);
router.post('/admin/:id/retry-refund', adminOnly, validate(idParam), controller.adminRetryRefund);
router.post('/admin/:id/reschedule', adminOnly, validate(adminRescheduleSchema), controller.adminReschedule);
router.get('/:id/nearby-partners', adminOnly, validate(idParam), controller.nearbyPartners);
router.post('/:id/dispatch', adminOnly, validate(dispatchSchema), controller.reassign);

// ── Customer routes ──────────────────────────────────────────────────────
router.post('/', customerOnly, validate(createSchema), controller.create);
router.get('/me', customerOnly, validate(listMineQuerySchema), controller.listMine);
router.get('/:id', customerOnly, validate(idParam), controller.getOwn);
router.post('/:id/cancel', customerOnly, validate(cancelSchema), controller.cancelOwn);
router.post('/:id/rate', customerOnly, validate(rateBookingSchema), controller.rateBooking);

module.exports = router;
