const jwt = require('jsonwebtoken');
const env = require('../config/env');

const signToken = (payload, options = {}) =>
  jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN, ...options });

const verifyToken = (token) => jwt.verify(token, env.JWT_SECRET);

module.exports = { signToken, verifyToken };
