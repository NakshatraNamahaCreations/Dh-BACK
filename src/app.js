require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const logger = require('./config/logger');
const { decodeToken } = require('./utils/jwt');
const routes = require('./routes');
const adminAudit = require('./middlewares/adminAudit');
const notFound = require('./middlewares/notFound');
const errorHandler = require('./middlewares/errorHandler');

const app = express();

app.set('trust proxy', 1);

const captureRazorpayWebhookBody = (req, _res, buf) => {
  if (req.originalUrl?.startsWith('/api/v1/payments/razorpay/webhook')) {
    req.rawBody = Buffer.from(buf);
  }
};

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '1mb', verify: captureRazorpayWebhookBody }));
app.use(express.urlencoded({ extended: true }));

if (env.NODE_ENV !== 'test') {
  app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: logger.stream }));
}

/// Global API limiter. Keyed by user id when an Authorization header
/// is present so each logged-in user gets their own budget; falls back
/// to IP for anonymous routes (login, OTP, health). The cap is sized
/// for a normal mobile session — a partner opening the app does ~30-50
/// requests in 5 min (dashboard, bookings, polling, socket handshake).
/// The per-IP fallback is intentionally generous so multiple testers
/// sharing one office NAT don't all share a single 300-call budget.
const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    /// Per-USER budget. Decode the JWT (no signature check needed here —
    /// the auth middleware enforces validity downstream) and key on the
    /// stable subject claim so every logged-in user gets their own bucket.
    /// NOTE: the old `auth.slice(7, 32)` keyed on the first 25 chars of the
    /// token, which for every HS256 JWT is the IDENTICAL header segment
    /// (`eyJhbGciOiJIUzI1Ni…`) — so ALL authenticated users collided into a
    /// single shared bucket and throttled each other. Keying on `sub` fixes
    /// that. Falls back to IP for anonymous routes (login, OTP, health) and
    /// for any malformed token that fails to decode.
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const payload = decodeToken(auth.slice(7));
      if (payload && payload.sub != null) return `u:${payload.type || '?'}:${payload.sub}`;
    }
    return req.ip;
  },
  message: { success: false, message: 'Too many requests. Please slow down and try again in a minute.' },
});
app.use('/api', apiLimiter);

app.use(adminAudit);
app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
