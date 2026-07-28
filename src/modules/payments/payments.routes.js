const express = require('express');
const validate = require('../../middlewares/validate');
const { authenticate, requireType, requirePermission } = require('../../middlewares/auth');
const {
  saveCommissionSchema,
  partnerSummariesQuerySchema,
  partnerEarningsQuerySchema,
  generatePayoutSchema,
  payoutListQuerySchema,
  approvePayoutSchema,
  markPaidSchema,
  rejectPayoutSchema,
  ledgerQuerySchema,
  razorpayCreateOrderSchema,
  razorpayVerifySchema,
  razorpayAddOnOrderSchema,
  razorpayAddOnVerifySchema,
  razorpayReconcileSchema,
  weeklyQuerySchema,
  weeklyMarkPaidSchema,
  weeklyRemarkSchema,
  monthlyReportQuerySchema,
} = require('./payments.validator');
const controller = require('./payments.controller');

const router = express.Router();

const adminOnly = [authenticate, requireType('ADMIN')];
const customerOnly = [authenticate, requireType('CUSTOMER')];

// ── Razorpay (customer-facing) ─────────────────────────────────────────────
// Webhook MUST be registered with express.raw() so the signature can be
// verified against the exact bytes Razorpay sent. JSON-parsed body would
// not hash to the same value. The webhook is intentionally unauthenticated
// — Razorpay only knows the WEBHOOK_SECRET (a shared HMAC key).
router.post(
  '/razorpay/webhook',
  express.raw({ type: 'application/json' }),
  controller.razorpayWebhook,
);
router.post(
  '/razorpay/order',
  customerOnly,
  validate(razorpayCreateOrderSchema),
  controller.razorpayCreateOrder,
);
router.post(
  '/razorpay/verify',
  customerOnly,
  validate(razorpayVerifySchema),
  controller.razorpayVerify,
);
// Active reconcile — server pulls the true order status from Razorpay and
// settles it. The app's backstop when the client verify never landed.
router.post(
  '/razorpay/reconcile',
  customerOnly,
  validate(razorpayReconcileSchema),
  controller.razorpayReconcile,
);
// Add-on side-bill: charges the flat sum of the booking's UNPAID
// partner-added services. Never touches the main bill's rollup.
router.post(
  '/razorpay/addon-order',
  customerOnly,
  validate(razorpayAddOnOrderSchema),
  controller.razorpayAddOnOrder,
);
router.post(
  '/razorpay/addon-verify',
  customerOnly,
  validate(razorpayAddOnVerifySchema),
  controller.razorpayAddOnVerify,
);

// ── Admin: Commission rules ────────────────────────────────────────────────
router.get('/commission', adminOnly, requirePermission('commission.view'), controller.getCommission);
router.put('/commission', adminOnly, requirePermission('commission.edit'), validate(saveCommissionSchema), controller.saveCommission);

// ── Admin: Partner earnings ────────────────────────────────────────────────
// Top-level summary list drives the Payout management table. The two
// per-partner endpoints power the drill-in / partner detail page.
router.get('/earnings/partners', adminOnly, requirePermission('payouts.view'), validate(partnerSummariesQuerySchema), controller.listPartnerSummaries);
router.get('/earnings/partners/:id/summary', adminOnly, requirePermission('payouts.view'), controller.getPartnerSummary);
router.get('/earnings/partners/:id', adminOnly, requirePermission('payouts.view'), validate(partnerEarningsQuerySchema), controller.listPartnerEarnings);

// ── Admin: Weekly settlements (Mon–Sun) ────────────────────────────────────
// Aggregated per-partner earnings for a week + bulk mark-paid after the
// admin has run the bank transfers from the exported CSV.
router.get('/weekly', adminOnly, requirePermission('payouts.view'), validate(weeklyQuerySchema), controller.weeklySettlements);
router.post('/weekly/mark-paid', adminOnly, requirePermission('payouts.mark_paid'), validate(weeklyMarkPaidSchema), controller.weeklyMarkPaid);
router.post('/weekly/remark', adminOnly, requirePermission('payouts.mark_paid'), validate(weeklyRemarkSchema), controller.weeklySaveRemark);
// Calendar-month settlement report with the full GST breakdown (accountant view).
router.get('/report/monthly', adminOnly, requirePermission('payouts.view'), validate(monthlyReportQuerySchema), controller.monthlyReport);

// ── Admin: Payouts ─────────────────────────────────────────────────────────
router.post('/payouts', adminOnly, requirePermission('payouts.view'), validate(generatePayoutSchema), controller.generatePayout);
router.get('/payouts', adminOnly, requirePermission('payouts.view'), validate(payoutListQuerySchema), controller.listPayouts);
router.get('/payouts/:id', adminOnly, requirePermission('payouts.view'), controller.getPayout);
router.post('/payouts/:id/approve', adminOnly, requirePermission('payouts.approve'), validate(approvePayoutSchema), controller.approvePayout);
router.post('/payouts/:id/mark-paid', adminOnly, requirePermission('payouts.mark_paid'), validate(markPaidSchema), controller.markPayoutPaid);
router.post('/payouts/:id/reject', adminOnly, requirePermission('payouts.reject'), validate(rejectPayoutSchema), controller.rejectPayout);

// ── Admin: Ledger (legacy view, unchanged) ─────────────────────────────────
router.get('/ledger', adminOnly, requirePermission('payments.view'), validate(ledgerQuerySchema), controller.listLedger);

module.exports = router;
