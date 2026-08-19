const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const service = require('./bookings.service');

exports.create = asyncHandler(async (req, res) => {
  /// `Idempotency-Key` is optional — if the client sends one, we
  /// dedupe retries against an in-progress / completed booking that
  /// shares the same key. Without the header (legacy clients, third-
  /// party callers) the create proceeds normally with no dedup.
  const idempotencyKey =
    req.headers['idempotency-key']?.toString().trim() || null;
  const item = await service.create({
    customerId: req.user.sub,
    payload: req.body,
    idempotencyKey,
  });
  created(res, item, 'Booking placed');
});

exports.listMine = asyncHandler(async (req, res) => {
  const items = await service.listMine({
    customerId: req.user.sub,
    status: req.query.status,
    bucket: req.query.bucket,
  });
  success(res, items, 'Bookings fetched');
});

exports.getOwn = asyncHandler(async (req, res) => {
  const item = await service.getOwn({ customerId: req.user.sub, id: req.params.id });
  success(res, item, 'Booking fetched');
});

exports.availability = asyncHandler(async (req, res) => {
  const result = await service.availability({
    customerId: req.user.sub,
    id: req.params.id,
  });
  success(res, result, 'Partner availability fetched');
});

exports.nearbyEta = asyncHandler(async (req, res) => {
  const result = await service.nearbyEta({
    lat: req.query.lat,
    lng: req.query.lng,
  });
  success(res, result, 'Nearby ETA fetched');
});

exports.cancellationQuote = asyncHandler(async (req, res) => {
  const quote = await service.cancellationQuote({
    customerId: req.user.sub,
    id: req.params.id,
  });
  success(res, quote, 'Cancellation quote');
});

exports.cancelOwn = asyncHandler(async (req, res) => {
  const item = await service.cancelOwn({
    customerId: req.user.sub,
    id: req.params.id,
    reason: req.body?.reason,
  });
  success(res, item, 'Booking cancelled');
});

exports.rateBooking = asyncHandler(async (req, res) => {
  const item = await service.rateBooking({
    customerId: req.user.sub,
    id: req.params.id,
    stars: req.body.stars,
    comment: req.body?.comment,
  });
  success(res, item, 'Rating saved');
});

// ── Admin endpoints ─────────────────────────────────────────────────────────

exports.adminCreate = asyncHandler(async (req, res) => {
  const item = await service.adminCreate({ payload: req.body });
  success(res, item, 'Booking created', 201);
});

exports.adminList = asyncHandler(async (req, res) => {
  const { scopeByAdmin } = require('../../middlewares/adminScope');
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await service.adminList({ ...req.query, scope });
  success(res, data, 'Bookings fetched', 200, meta);
});

exports.adminGet = asyncHandler(async (req, res) => {
  const item = await service.adminGet(req.params.id);
  success(res, item, 'Booking fetched');
});

exports.adminDownloadInvoice = asyncHandler(async (req, res) => {
  /// ?doc=partner downloads the partner receipt; default is the Dhoond
  /// tax invoice. Anything else falls back to the invoice.
  const docType = req.query.doc === 'partner' ? 'partner' : 'customer';
  const { pdf, filename } = await service.adminInvoicePdf(req.params.id, docType);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', pdf.length);
  res.send(pdf);
});

exports.adminSendInvoiceEmail = asyncHandler(async (req, res) => {
  const result = await service.adminSendInvoiceEmail(req.params.id);
  success(res, result, `Invoice emailed to ${result.email}`);
});

exports.liveJobs = asyncHandler(async (req, res) => {
  const { scopeByAdmin } = require('../../middlewares/adminScope');
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const items = await service.liveJobs({ scope });
  success(res, items, 'Live jobs fetched');
});

exports.listDisputes = asyncHandler(async (req, res) => {
  const { data, meta } = await service.listDisputes(req.query);
  success(res, data, 'Disputes fetched', 200, meta);
});

exports.resolveDispute = asyncHandler(async (req, res) => {
  const item = await service.resolveDispute(req.params.id, req.body.resolution, req.body.action);
  success(res, item, 'Dispute resolved');
});

exports.addDisputeNote = asyncHandler(async (req, res) => {
  const item = await service.addDisputeNote(req.params.id, req.body.text);
  success(res, item, 'Note added');
});

exports.listStuckJobs = asyncHandler(async (_req, res) => {
  const items = await service.listStuckJobs();
  success(res, items, 'Stuck jobs fetched');
});

exports.nearbyPartners = asyncHandler(async (req, res) => {
  const items = await service.nearbyPartners(req.params.id);
  success(res, items, 'Nearby partners fetched');
});

exports.reassign = asyncHandler(async (req, res) => {
  const item = await service.reassign(req.params.id, req.body.partnerId, req.body.reason);
  success(res, item, 'Booking reassigned');
});

exports.adminUpdateStatus = asyncHandler(async (req, res) => {
  const item = await service.adminUpdateStatus(req.params.id, req.body.status, req.body.note);
  success(res, item, 'Booking status updated');
});

exports.adminCancel = asyncHandler(async (req, res) => {
  const item = await service.adminCancel(req.params.id, req.body.reason);
  success(res, item, 'Booking cancelled');
});

exports.adminRetryRefund = asyncHandler(async (req, res) => {
  const item = await service.adminRetryRefund(req.params.id);
  success(res, item, 'Refund initiated');
});

exports.adminMarkPaid = asyncHandler(async (req, res) => {
  const item = await service.adminMarkPaid(req.params.id, req.body);
  success(res, item, 'Payment recorded');
});

exports.adminReschedule = asyncHandler(async (req, res) => {
  const item = await service.adminReschedule(req.params.id, req.body);
  success(res, item, 'Booking rescheduled');
});

// ── Partner endpoints ────────────────────────────────────────────────────────

exports.partnerIncoming = asyncHandler(async (req, res) => {
  const items = await service.partnerIncoming({
    partnerId: req.user.sub,
    lat: req.query.lat,
    lng: req.query.lng,
    radiusKm: req.query.radiusKm,
  });
  success(res, items, 'Incoming bookings fetched');
});

exports.partnerAccept = asyncHandler(async (req, res) => {
  const item = await service.partnerAccept({
    bookingId: req.params.id,
    partnerId: req.user.sub,
  });
  success(res, item, 'Booking accepted');
});

exports.partnerMine = asyncHandler(async (req, res) => {
  const items = await service.partnerMine({
    partnerId: req.user.sub,
    bucket: req.query.bucket,
  });
  success(res, items, 'Bookings fetched');
});

exports.partnerCancel = asyncHandler(async (req, res) => {
  const result = await service.partnerCancel({
    partnerId: req.user.sub,
    id: req.params.id,
    reason: req.body?.reason,
  });
  success(res, result, 'Booking released');
});

exports.partnerUpdateStatus = asyncHandler(async (req, res) => {
  const item = await service.partnerUpdateStatus({
    bookingId: req.params.id,
    partnerId: req.user.sub,
    status: req.body.status,
    otp: req.body.otp,
  });
  success(res, item, 'Status updated');
});

exports.partnerAddAddOns = asyncHandler(async (req, res) => {
  const item = await service.partnerAddAddOns({
    bookingId: req.params.id,
    partnerId: req.user.sub,
    items: req.body.items,
  });
  success(res, item, 'Add-ons added');
});

exports.partnerRemoveAddOn = asyncHandler(async (req, res) => {
  const item = await service.partnerRemoveAddOn({
    bookingId: req.params.id,
    partnerId: req.user.sub,
    addOnId: req.params.addOnId,
  });
  success(res, item, 'Add-on removed');
});
