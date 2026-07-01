const jwt = require('jsonwebtoken');
const env = require('../config/env');

const signToken = (payload, options = {}) =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN, ...options });

const verifyToken = (token) => jwt.verify(token, env.JWT_SECRET);

/// Decode WITHOUT verifying the signature — cheap base64 parse, never
/// throws (returns null on a malformed token). Used by the rate limiter
/// to derive a per-user bucket key before the auth middleware has run,
/// where we only need the claims (sub/type), not trust in them.
const decodeToken = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};

module.exports = { signToken, verifyToken, decodeToken };
