const express = require('express');
const authRoutes = require('../modules/auth/auth.routes');
const categoryRoutes = require('../modules/categories/categories.routes');
const subCategoryRoutes = require('../modules/sub-categories/sub-categories.routes');
const serviceRoutes = require('../modules/services/services.routes');
const uploadRoutes = require('../modules/uploads/uploads.routes');
const bannerRoutes = require('../modules/banners/banners.routes');
const bookingRoutes = require('../modules/bookings/bookings.routes');
const pricingRoutes = require('../modules/pricing/pricing.routes');
const analyticsRoutes = require('../modules/analytics/analytics.routes');
const partnersRoutes = require('../modules/partners/partners.routes');
const paymentsRoutes = require('../modules/payments/payments.routes');
const policyRoutes = require('../modules/policy/policy.routes');
const rolesRoutes = require('../modules/roles/roles.routes');
const serviceAreaRoutes = require('../modules/service-areas/service-areas.routes');
const launchInterestRoutes = require('../modules/launch-interest/launch-interest.routes');
const customerRoutes = require('../modules/customers/customers.routes');
const timeSlotRoutes = require('../modules/time-slots/time-slots.routes');
const auditLogRoutes = require('../modules/audit-logs/audit-logs.routes');
const couponRoutes = require('../modules/coupons/coupons.routes');
const trackingRoutes = require('../modules/tracking/tracking.routes');
const geographyRoutes = require('../modules/geography/geography.routes');
const adminsRoutes = require('../modules/admins/admins.routes');
const accountDeletionRoutes = require('../modules/account-deletion/account-deletion.routes');
const kycRoutes = require('../modules/kyc/kyc.routes');
const kycAdminRoutes = require('../modules/kyc/kyc.admin.routes');
const partnerNotificationRoutes = require('../modules/notifications/notifications.routes');
const pushBroadcastRoutes = require('../modules/push-broadcasts/push-broadcasts.routes');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ success: true, message: 'OK', uptime: process.uptime() });
});

router.use('/auth', authRoutes);
router.use('/categories', categoryRoutes);
router.use('/sub-categories', subCategoryRoutes);
router.use('/services', serviceRoutes);
router.use('/uploads', uploadRoutes);
router.use('/banners', bannerRoutes);
router.use('/bookings', bookingRoutes);
router.use('/pricing', pricingRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/partners', partnersRoutes);
router.use('/payments', paymentsRoutes);
router.use('/policy', policyRoutes);
router.use('/roles', rolesRoutes);
router.use('/service-areas', serviceAreaRoutes);
router.use('/launch-interest', launchInterestRoutes);
router.use('/customers', customerRoutes);
router.use('/time-slots', timeSlotRoutes);
router.use('/audit-logs', auditLogRoutes);
router.use('/coupons', couponRoutes);
router.use('/tracking', trackingRoutes);
router.use('/geography', geographyRoutes);
router.use('/admins', adminsRoutes);
router.use('/account-deletion-requests', accountDeletionRoutes);
router.use('/kyc', kycRoutes);
/// Admin-side KYC for in-house partner creation — `:partnerId` is in
/// the path so the admin wizard can target a specific partner. Order
/// matters: this MUST be mounted before any wildcard `/partners/:id`
/// route in partnersRoutes that might shadow it. The Express router
/// in partners.routes.js uses `/:id` at the top level, but Express
/// mounts these as separate routers so they don't collide — each
/// `router.use(path, ...)` is matched independently.
router.use('/partners/:partnerId/kyc', kycAdminRoutes);
router.use('/partners/me/notifications', partnerNotificationRoutes);
router.use('/push-broadcasts', pushBroadcastRoutes);

/// PUBLIC app-update config — the customer/partner apps fetch this on
/// launch (before login) to decide whether to show an "Update available"
/// or "Update required" prompt. No auth: it's a launch gate. `?app=`.
router.get('/app-config', require('../modules/policy/policy.controller').getAppConfig);

module.exports = router;
