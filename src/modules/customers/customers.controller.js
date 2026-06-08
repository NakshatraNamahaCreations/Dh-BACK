const asyncHandler = require('../../utils/asyncHandler');
const { success, created } = require('../../utils/apiResponse');
const { scopeByAdmin, assertInScope } = require('../../middlewares/adminScope');
const prisma = require('../../config/prisma');
const service = require('./customers.service');

/// Guard a single-customer detail/mutation request against the admin's
/// city scope. SUPER admins pass straight through; a CITY_MANAGER may only
/// view/suspend customers who have at least one booking in their assigned
/// cities (customers have no direct cityId — same relation the list scopes
/// on). Runs BEFORE the service call so a scoped admin can't read or toggle
/// an out-of-city customer by guessing the id. A customer with no bookings
/// has no resolvable city and is therefore out of scope for a scoped admin
/// (fail closed).
const ensureCustomerInScope = async (req) => {
  const scope = await scopeByAdmin(req);
  if (scope.cityIds == null) return; // SUPER / unscoped — skip the lookup
  const id = Number(req.params.id);
  const exists = await prisma.customer.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return; // let the service layer 404
  /// Distinct booking cities for this customer; cap the scan — one match
  /// in the admin's set is enough to authorise.
  const bookingCities = await prisma.booking.findMany({
    where: { customerId: id, cityId: { in: scope.cityIds } },
    select: { cityId: true },
    take: 1,
  });
  assertInScope(scope, bookingCities.map((b) => b.cityId));
};

exports.list = asyncHandler(async (req, res) => {
  const scope = await scopeByAdmin(req, {
    cityId: req.query.cityId,
    stateId: req.query.stateId,
  });
  const { data, meta } = await service.list({ ...req.query, scope });
  success(res, data, 'Customers fetched', 200, meta);
});

exports.get = asyncHandler(async (req, res) => {
  await ensureCustomerInScope(req);
  const item = await service.get(Number(req.params.id));
  success(res, item, 'Customer fetched');
});

exports.toggleActive = asyncHandler(async (req, res) => {
  await ensureCustomerInScope(req);
  const item = await service.toggleActive(Number(req.params.id));
  success(res, item, 'Customer status updated');
});

// ── Customer-facing saved addresses ────────────────────────────────────────

exports.listMyAddresses = asyncHandler(async (req, res) => {
  const items = await service.listAddresses(req.user.sub);
  success(res, items, 'Addresses fetched');
});

exports.createMyAddress = asyncHandler(async (req, res) => {
  const item = await service.createAddress(req.user.sub, req.body);
  created(res, item, 'Address saved');
});

exports.updateMyAddress = asyncHandler(async (req, res) => {
  const item = await service.updateAddress(req.user.sub, req.params.id, req.body);
  success(res, item, 'Address updated');
});

exports.deleteMyAddress = asyncHandler(async (req, res) => {
  const result = await service.deleteAddress(req.user.sub, req.params.id);
  success(res, result, 'Address removed');
});

exports.setMyDefaultAddress = asyncHandler(async (req, res) => {
  const item = await service.setDefaultAddress(req.user.sub, req.params.id);
  success(res, item, 'Default address updated');
});
