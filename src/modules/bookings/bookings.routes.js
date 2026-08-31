const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission, requireAnyPermission } = require('../../middlewares/auth');
const {
  idParam,
  createSchema,
  listMineQuerySchema,
  cancelSchema,
  adminCreateSchema,
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
  partnerAddOnsSchema,
  partnerRemoveAddOnSchema,
  partnerCancelSchema,
  rateBookingSchema,
  nearbyEtaQuerySchema,
  instantAvailabilityQuerySchema,
} = require('./bookings.validator');
const controller = require('./bookings.controller');

const router = express.Router();

const customerOnly = [authenticate, requireType('CUSTOMER')];
const adminOnly = [authenticate, requireType('ADMIN')];
const partnerOnly = [authenticate, requireType('PARTNER')];

// ── Partner routes (before /:id catch-alls) ──────────────────────────────────
router.get('/partner/incoming', partnerOnly, validate(partnerIncomingQuerySchema), controller.partnerIncoming);
router.get('/partner/mine', partnerOnly, validate(partnerMineQuerySchema), controller.partnerMine);
router.get('/partner/cancellations/mine', partnerOnly, controller.myCancellations);
router.get('/partner/status-history/mine', partnerOnly, controller.myStatusHistory);
router.post('/partner/:id/accept', partnerOnly, validate(idParam), controller.partnerAccept);
router.post('/partner/:id/cancel', partnerOnly, validate(partnerCancelSchema), controller.partnerCancel);
router.post('/partner/:id/status', partnerOnly, validate(partnerStatusSchema), controller.partnerUpdateStatus);
router.post('/partner/:id/addons', partnerOnly, validate(partnerAddOnsSchema), controller.partnerAddAddOns);
router.delete('/partner/:id/addons/:addOnId', partnerOnly, validate(partnerRemoveAddOnSchema), controller.partnerRemoveAddOn);

// ── Admin routes (registered before customer-scoped routes so /admin and
//    /live etc. don't collide with the catch-all /:id) ─────────────────────
router.post('/admin', adminOnly, requirePermission('bookings.edit'), validate(adminCreateSchema), controller.adminCreate);
router.get('/admin', adminOnly, requirePermission('bookings.view'), validate(adminListQuerySchema), controller.adminList);
router.get('/live', adminOnly, requirePermission('bookings.view'), controller.liveJobs);
router.get('/disputes', adminOnly, requirePermission('bookings.view'), validate(disputesListQuerySchema), controller.listDisputes);
/// Fine-grained Booking-details actions. Each accepts its own key OR the
/// legacy `bookings.edit` master key (requireAnyPermission), so roles
/// carrying the old coarse grant keep every action while new roles can be
/// given one action at a time from Roles & access. Disputes ride on
/// `bookings.dispatch` — the Roles screen groups them together
/// ("Manual dispatch & disputes").
router.post('/disputes/:id/resolve', adminOnly, requireAnyPermission('bookings.dispatch', 'bookings.edit'), validate(resolveDisputeSchema), controller.resolveDispute);
router.post('/disputes/:id/notes', adminOnly, requireAnyPermission('bookings.dispatch', 'bookings.edit'), validate(disputeNoteSchema), controller.addDisputeNote);
router.get('/stuck', adminOnly, requirePermission('bookings.view'), controller.listStuckJobs);
router.get('/admin/:id', adminOnly, requirePermission('bookings.view'), validate(idParam), controller.adminGet);
router.get('/admin/:id/invoice', adminOnly, requirePermission('bookings.view'), validate(idParam), controller.adminDownloadInvoice);
router.post('/admin/:id/send-invoice', adminOnly, requireAnyPermission('bookings.invoice', 'bookings.edit'), validate(idParam), controller.adminSendInvoiceEmail);
router.patch('/admin/:id/status', adminOnly, requireAnyPermission('bookings.status', 'bookings.edit'), validate(adminStatusSchema), controller.adminUpdateStatus);
router.post('/admin/:id/cancel', adminOnly, requireAnyPermission('bookings.cancel', 'bookings.edit'), validate(adminCancelSchema), controller.adminCancel);
router.post('/admin/:id/mark-paid', adminOnly, requireAnyPermission('bookings.mark_paid', 'bookings.edit'), validate(adminMarkPaidSchema), controller.adminMarkPaid);
router.post('/admin/:id/retry-refund', adminOnly, requirePermission('bookings.refund'), validate(idParam), controller.adminRetryRefund);
router.post('/admin/:id/reschedule', adminOnly, requireAnyPermission('bookings.reschedule', 'bookings.edit'), validate(adminRescheduleSchema), controller.adminReschedule);
router.get('/:id/nearby-partners', adminOnly, requirePermission('bookings.view'), validate(idParam), controller.nearbyPartners);
router.post('/:id/dispatch', adminOnly, requirePermission('bookings.dispatch'), validate(dispatchSchema), controller.reassign);

// ── Customer routes ──────────────────────────────────────────────────────
router.post('/', customerOnly, validate(createSchema), controller.create);
router.get('/me', customerOnly, validate(listMineQuerySchema), controller.listMine);
/// Home arrival-promise ETA. MUST be registered before `/:id` so the
/// literal path isn't captured as a booking id. Takes lat/lng query params.
router.get('/nearby-eta', customerOnly, validate(nearbyEtaQuerySchema), controller.nearbyEta);
router.get('/instant-availability', customerOnly, validate(instantAvailabilityQuerySchema), controller.instantAvailability);
router.get('/:id', customerOnly, validate(idParam), controller.getOwn);
router.get('/:id/availability', customerOnly, validate(idParam), controller.availability);
router.get('/:id/cancellation-quote', customerOnly, validate(idParam), controller.cancellationQuote);
router.post('/:id/cancel', customerOnly, validate(cancelSchema), controller.cancelOwn);
router.post('/:id/rate', customerOnly, validate(rateBookingSchema), controller.rateBooking);

module.exports = router;
