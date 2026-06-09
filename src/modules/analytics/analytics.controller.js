const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const { scopeByAdmin } = require('../../middlewares/adminScope');
const service = require('./analytics.service');

/// Every analytics endpoint is scoped to the requesting admin's cities.
/// `scopeByAdmin` returns `{ cityIds: null }` for a SUPER admin (no
/// scoping — sees the whole platform) and `{ cityIds: [...] }` for a
/// CITY_MANAGER (their assignment), which the service folds into every
/// booking / partner / customer query.
exports.summary = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.summary(scope);
  success(res, data, 'Summary fetched');
});

exports.revenueSeries = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.revenueSeries(req.query, scope);
  success(res, data, 'Revenue series fetched');
});

exports.bookings = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.bookingAnalytics(req.query, scope);
  success(res, data, 'Booking analytics fetched');
});

exports.revenue = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.revenueReport(req.query, scope);
  success(res, data, 'Revenue report fetched');
});

exports.partners = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.partnerPerformance(req.query, scope);
  success(res, data, 'Partner performance fetched');
});

exports.customers = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.customerInsights(req.query, scope);
  success(res, data, 'Customer insights fetched');
});

exports.bookingReport = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req);
  const data = await service.bookingReport(req.query, scope);
  success(res, data, 'Booking report fetched');
});
