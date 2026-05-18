const asyncHandler = require('../../utils/asyncHandler');
const { success } = require('../../utils/apiResponse');
const service = require('./analytics.service');

exports.summary = asyncHandler(async (_req, res) => {
  const data = await service.summary();
  success(res, data, 'Summary fetched');
});

exports.revenueSeries = asyncHandler(async (req, res) => {
  const data = await service.revenueSeries(req.query);
  success(res, data, 'Revenue series fetched');
});

exports.bookings = asyncHandler(async (req, res) => {
  const data = await service.bookingAnalytics(req.query);
  success(res, data, 'Booking analytics fetched');
});

exports.revenue = asyncHandler(async (req, res) => {
  const data = await service.revenueReport(req.query);
  success(res, data, 'Revenue report fetched');
});

exports.partners = asyncHandler(async (req, res) => {
  const data = await service.partnerPerformance(req.query);
  success(res, data, 'Partner performance fetched');
});

exports.customers = asyncHandler(async (req, res) => {
  const data = await service.customerInsights(req.query);
  success(res, data, 'Customer insights fetched');
});
