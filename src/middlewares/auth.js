const { verifyToken } = require('../utils/jwt');
const ApiError = require('../utils/ApiError');

const authenticate = (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw ApiError.unauthorized('Missing or invalid Authorization header');
    }
    const token = header.slice(7);
    const payload = verifyToken(token);
    /// Payload shape:
    ///   - CUSTOMER / PARTNER: { sub, type }
    ///   - ADMIN:              { sub, type, role, cityIds }
    /// role/cityIds are only present on admin tokens; consumers must
    /// guard accordingly (or use the scope helper which handles the
    /// missing-fields case).
    req.user = payload;
    next();
  } catch (err) {
    next(err);
  }
};

const requireType = (...types) => (req, res, next) => {
  if (!req.user) return next(ApiError.unauthorized());
  if (types.length && !types.includes(req.user.type)) {
    return next(ApiError.forbidden('Insufficient permissions'));
  }
  next();
};

/// RBAC gate. Use AFTER `authenticate` + `requireType('ADMIN')` on
/// admin routes that need a specific permission. Passes when:
///   - the admin's role is `super` (the all-bypass flag), OR
///   - the admin's token `perms` includes every listed permission.
///
/// Routes WITHOUT this middleware stay un-gated (authenticated-admin
/// only), so enforcement can be rolled out route-by-route without ever
/// breaking an endpoint that hasn't been annotated yet.
///
/// Legacy-token fallback: tokens minted before RBAC carry neither
/// `super` nor `perms`. We approximate from the scope role — a legacy
/// SUPER passes everything; a legacy CITY_MANAGER passes any permission
/// EXCEPT access-control (`admins.*` / `roles.*`), exactly mirroring the
/// old `requireRole('SUPER')` gate. Those admins get exact RBAC the next
/// time they log in.
const requirePermission = (...required) => (req, res, next) => {
  if (!req.user || req.user.type !== 'ADMIN') {
    return next(ApiError.forbidden('Insufficient permissions'));
  }
  if (req.user.super === true) return next();

  let perms = req.user.perms;
  if (perms === undefined && req.user.super === undefined) {
    /// Legacy token — no RBAC claims baked in.
    if ((req.user.role || 'SUPER') === 'SUPER') return next();
    const ok = required.every((p) => !p.startsWith('admins.') && !p.startsWith('roles.'));
    return ok ? next() : next(ApiError.forbidden('You do not have permission for this action'));
  }

  perms = Array.isArray(perms) ? perms : [];
  const ok = required.every((p) => perms.includes(p));
  return ok ? next() : next(ApiError.forbidden('You do not have permission for this action'));
};

module.exports = { authenticate, requireType, requirePermission };
