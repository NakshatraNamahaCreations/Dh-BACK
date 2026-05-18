require('express-async-errors');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config/env');
const logger = require('./config/logger');
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

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

app.use(adminAudit);
app.use('/api/v1', routes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
