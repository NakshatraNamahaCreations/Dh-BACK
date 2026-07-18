const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const { scopeByAdmin } = require('../../middlewares/adminScope');
const service = require('./payments.service');
const commissions = require('./commissions.service');
const earnings = require('./earnings.service');
const payouts = require('./payouts.service');
const razorpay = require('./razorpay.service');

// ── Commission rules ──────────────────────────────────────────────────────

exports.getCommission = asyncHandler(async (_req, res) => {
  const data = await commissions.listAll();
  success(res, data, 'Commission rules fetched');
});

exports.saveCommission = asyncHandler(async (req, res) => {
  const data = await commissions.upsertMany(req.body.rows);
  success(res, data, 'Commission rules saved');
});

// ── Earnings ───────────────────────────────────────────────────────────────

exports.listPartnerSummaries = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await earnings.listPartnerSummaries({ ...req.query, scope });
  success(res, data, 'Partner earnings fetched', 200, meta);
});

exports.getPartnerSummary = asyncHandler(async (req, res) => {
  const data = await earnings.summaryForPartner(req.params.id);
  success(res, data, 'Partner summary fetched');
});

// ── Weekly settlements (Mon–Sun) ───────────────────────────────────────────

exports.weeklySettlements = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const data = await earnings.weeklySettlements({ weekStart: req.query.weekStart, scope });
  success(res, data, 'Weekly settlements fetched');
});

exports.weeklyMarkPaid = asyncHandler(async (req, res) => {
  /// Scope from the body's geo filter (mirrors the UI's active State/City
  /// selection) intersected with the admin's own city assignment — so
  /// "Mark week paid" can never settle partners outside the filtered view.
  const scope = await scopeByAdmin(req, {
    cityId: req.body.cityId,
    stateId: req.body.stateId,
  });
  const data = await earnings.weeklyMarkPaid({
    weekStart: req.body.weekStart,
    partnerIds: req.body.partnerIds,
    scope,
  });
  success(res, data, 'Weekly settlements marked paid');
});

exports.monthlyReport = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const data = await earnings.monthlyReport({ month: req.query.month, scope });
  success(res, data, 'Monthly report fetched');
});

exports.weeklySaveRemark = asyncHandler(async (req, res) => {
  const data = await earnings.weeklySaveRemark({
    weekStart: req.body.weekStart,
    partnerId: req.body.partnerId,
    remark: req.body.remark,
  });
  success(res, data, 'Remark saved');
});

exports.listPartnerEarnings = asyncHandler(async (req, res) => {
  const { data, meta } = await earnings.listForPartner({
    partnerId: req.params.id,
    ...req.query,
  });
  success(res, data, 'Partner earnings fetched', 200, meta);
});

// ── Payouts ────────────────────────────────────────────────────────────────

exports.generatePayout = asyncHandler(async (req, res) => {
  const data = await payouts.generateForPartner(req.body);
  success(res, data, 'Payout generated', 201);
});

exports.listPayouts = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await payouts.list({ ...req.query, scope });
  success(res, data, 'Payouts fetched', 200, meta);
});

exports.getPayout = asyncHandler(async (req, res) => {
  const data = await payouts.get(req.params.id);
  success(res, data, 'Payout fetched');
});

exports.approvePayout = asyncHandler(async (req, res) => {
  const data = await payouts.approve({
    payoutId: req.params.id,
    adminId: req.user?.sub ? Number(req.user.sub) : null,
    notes: req.body?.notes,
  });
  success(res, data, 'Payout approved');
});

exports.markPayoutPaid = asyncHandler(async (req, res) => {
  const data = await payouts.markPaid({
    payoutId: req.params.id,
    reference: req.body.reference,
    notes: req.body?.notes,
  });
  success(res, data, 'Payout marked paid');
});

exports.rejectPayout = asyncHandler(async (req, res) => {
  const data = await payouts.reject({
    payoutId: req.params.id,
    notes: req.body.notes,
  });
  success(res, data, 'Payout rejected');
});

// ── Ledger (legacy, computed view — unchanged) ─────────────────────────────

exports.listLedger = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await service.listLedger({ ...req.query, scope });
  success(res, data, 'Ledger fetched', 200, meta);
});

// ── Razorpay (customer-facing, unchanged) ──────────────────────────────────

exports.razorpayCreateOrder = asyncHandler(async (req, res) => {
  const data = await razorpay.createOrder({
    bookingId: req.body.bookingId,
    customerId: req.user.sub,
  });
  success(res, data, 'Razorpay order created');
});

exports.razorpayVerify = asyncHandler(async (req, res) => {
  const booking = await razorpay.verifyPayment({
    bookingId: req.body.bookingId,
    customerId: req.user.sub,
    razorpayOrderId: req.body.razorpayOrderId,
    razorpayPaymentId: req.body.razorpayPaymentId,
    razorpaySignature: req.body.razorpaySignature,
  });
  success(res, { bookingId: booking.id, paymentStatus: booking.paymentStatus }, 'Payment verified');
});

exports.razorpayAddOnOrder = asyncHandler(async (req, res) => {
  const data = await razorpay.createAddOnOrder({
    bookingId: req.body.bookingId,
    customerId: req.user.sub,
  });
  success(res, data, 'Razorpay add-on order created');
});

exports.razorpayAddOnVerify = asyncHandler(async (req, res) => {
  const data = await razorpay.verifyAddOnPayment({
    bookingId: req.body.bookingId,
    customerId: req.user.sub,
    razorpayOrderId: req.body.razorpayOrderId,
    razorpayPaymentId: req.body.razorpayPaymentId,
    razorpaySignature: req.body.razorpaySignature,
  });
  success(res, data, 'Add-on payment verified');
});

exports.razorpayWebhook = asyncHandler(async (req, res) => {
  const result = await razorpay.handleWebhook({
    rawBody: req.rawBody ?? req.body,
    signature: req.get('x-razorpay-signature'),
  });
  res.json(result);
});
