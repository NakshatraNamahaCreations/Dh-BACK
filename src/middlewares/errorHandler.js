const { Prisma } = require('@prisma/client');
const { ZodError } = require('zod');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const logger = require('../config/logger');

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let details;

  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    statusCode = 400;
    message = 'Validation failed';
    details = err.flatten().fieldErrors;
  } else if (
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    /// Connection-level failures: DB unreachable (P1001), TLS issues,
    /// auth (P1000), engine crash. These are infra problems — surface
    /// as 503 so the frontend can offer a retry CTA instead of telling
    /// the user to change their inputs.
    statusCode = 503;
    message = 'Service temporarily unavailable. Please try again in a moment.';
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      statusCode = 409;
      message = `Unique constraint failed on field(s): ${err.meta?.target}`;
    } else if (err.code === 'P2025') {
      statusCode = 404;
      message = 'Record not found';
    } else if (
      /// Runtime connection errors that can fire AFTER the pool has
      /// been initialised — e.g. the network drops mid-query or the
      /// DB closes an idle pooled connection. Same UX as init errors.
      ['P1001', 'P1002', 'P1008', 'P1011', 'P1017'].includes(err.code)
    ) {
      statusCode = 503;
      message = 'Service temporarily unavailable. Please try again in a moment.';
    } else {
      statusCode = 400;
      message = `Database error: ${err.code}`;
    }
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
  } else if (err.message) {
    message = err.message;
  }

  if (statusCode >= 500) {
    logger.error(err.stack || err);
  }

  const body = { success: false, message };
  if (details) body.details = details;
  if (env.NODE_ENV !== 'production' && err.stack) body.stack = err.stack;

  res.status(statusCode).json(body);
};

module.exports = errorHandler;
