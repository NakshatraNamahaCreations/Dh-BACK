/**
 * Admin role + city-scope helpers used by every admin list endpoint.
 *
 * Two pieces:
 *
 *   1. `requireRole(...roles)` — middleware. Returns 403 if the admin's
 *      role isn't one of the allowed values. Use for super-admin-only
 *      endpoints (Admin Users management, geography edits, etc.).
 *
 *   2. `scopeByAdmin(req, requestedCityId, requestedStateIdToCityIds)` —
 *      service-layer helper. Given the requesting admin's JWT payload
 *      and the city/state filter from the query, returns the effective
 *      cityId filter to apply. Encodes the intersection rules:
 *
 *        - SUPER admin: returns the requested filter as-is. They have
 *          no city scope to intersect with.
 *
 *        - CITY_MANAGER with empty cityIds: returns `[]` (no match —
 *          the admin sees nothing until a SUPER assigns at least one
 *          city). Failing closed is the right default here.
 *
 *        - CITY_MANAGER with cityIds set:
 *            requested cityId in scope     → return [cityId]
 *            requested cityId out of scope → return [] (empty match)
 *            requested stateId set         → intersect the state's city
 *                                            list with the admin's scope
 *            no request filter             → return the admin's scope
 *
 *      Returns shape:
 *        { cityIds: number[] | null }
 *      where `null` means "no scoping needed, leave the WHERE alone"
 *      (SUPER admin without a filter), and an array (possibly empty)
 *      means "WHERE cityId IN (...)". Services translate that to the
 *      Prisma filter via `applyScopeToWhere()` below.
 */
const cityResolver = require('../modules/geography/city-resolver');
const ApiError = require('../utils/ApiError');

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || req.user.type !== 'ADMIN') {
    return next(ApiError.unauthorized());
  }
  const role = req.user.role || 'SUPER';
  if (!roles.includes(role)) {
    return next(ApiError.forbidden('Insufficient permissions for this action'));
  }
  next();
};

/// Resolve the effective city-id filter for an admin list query.
///
/// `requestedCityId` and `requestedStateId` come straight from the
/// query string. Both are optional. Returns `{ cityIds }` where
/// `cityIds === null` means "leave the WHERE clause alone" and a
/// numeric array (possibly empty) means "WHERE cityId IN (array)".
const scopeByAdmin = async (req, { cityId, stateId } = {}) => {
  const role = req.user?.role || 'SUPER';
  const adminCityIds = Array.isArray(req.user?.cityIds) ? req.user.cityIds : [];

  /// Expand the requested filter to a candidate set first.
  let requested = null;
  if (cityId != null) {
    requested = [Number(cityId)];
  } else if (stateId != null) {
    requested = await cityResolver.cityIdsInState(stateId);
  }

  if (role === 'SUPER') {
    return { cityIds: requested };
  }

  /// CITY_MANAGER (and any future scoped role) — intersect the
  /// requested filter with the admin's assignment. Without an
  /// explicit filter, fall back to the full assignment.
  if (adminCityIds.length === 0) {
    /// No cities assigned → user sees nothing. We return an empty
    /// array which translates to `cityId IN ()` — Prisma rejects that
    /// literally, so the consumer should swap to `cityId = -1` (an
    /// impossible id) to short-circuit. `applyScopeToWhere` does
    /// exactly that.
    return { cityIds: [] };
  }

  if (requested == null) {
    return { cityIds: adminCityIds };
  }
  const allow = new Set(adminCityIds);
  return { cityIds: requested.filter((id) => allow.has(id)) };
};

/// Convenience wrapper that mutates a Prisma `where` object in place.
/// Use from list services after building the rest of the WHERE clause.
const applyScopeToWhere = (where, scope) => {
  if (scope.cityIds == null) return where;
  if (scope.cityIds.length === 0) {
    /// Force a no-match — Prisma rejects an empty IN clause.
    where.cityId = -1;
  } else if (scope.cityIds.length === 1) {
    where.cityId = scope.cityIds[0];
  } else {
    where.cityId = { in: scope.cityIds };
  }
  return where;
};

/// Variant for endpoints whose subject (Customer, etc.) doesn't have
/// a direct cityId — the scope sits on a related Booking instead.
/// `relation` is the relation name on the parent model
/// (e.g. "bookings"). When SUPER admin and no filter: no-op.
const applyScopeToRelation = (where, scope, relation) => {
  if (scope.cityIds == null) return where;
  const cityFilter =
    scope.cityIds.length === 0
      ? -1
      : scope.cityIds.length === 1
        ? scope.cityIds[0]
        : { in: scope.cityIds };
  where[relation] = {
    ...(where[relation] ?? {}),
    some: { ...(where[relation]?.some ?? {}), cityId: cityFilter },
  };
  return where;
};

/// Assert that a single record is within the admin's city scope, for
/// DETAIL / MUTATION endpoints (get, update, suspend, approve…). List
/// endpoints filter in the WHERE clause; single-record endpoints must
/// check explicitly or a scoped admin could read/modify a partner or
/// customer outside their assigned cities by guessing the id.
///
/// `scope` is the result of `scopeByAdmin(req)`. `recordCityIds` is the
/// set of cityIds the record belongs to:
///   - Partner: `[partner.cityId]` (direct column; may be [null]).
///   - Customer: the cityIds of the customer's bookings.
/// SUPER admins (scope.cityIds == null) always pass. A scoped admin
/// passes only if at least one of the record's cityIds is in their set.
/// A record with no resolvable city (e.g. brand-new partner with no
/// cityId, or a customer with no bookings) is OUT of scope for a scoped
/// admin — fail closed, consistent with `scopeByAdmin` returning [] for
/// an unassigned manager.
const assertInScope = (scope, recordCityIds) => {
  if (!scope || scope.cityIds == null) return; // SUPER / unscoped → allow
  const allow = new Set(scope.cityIds);
  const cities = (recordCityIds ?? []).filter((id) => id != null);
  const ok = cities.some((id) => allow.has(id));
  if (!ok) {
    throw ApiError.forbidden('This record is outside your assigned cities.');
  }
};

module.exports = {
  requireRole,
  scopeByAdmin,
  applyScopeToWhere,
  applyScopeToRelation,
  assertInScope,
};
