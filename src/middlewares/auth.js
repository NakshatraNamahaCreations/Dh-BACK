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

module.exports = { authenticate, requireType };
