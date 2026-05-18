/**
 * Dispatch worker — standalone entrypoint.
 *
 * Run alongside the main API process when you want dispatch to scale
 * independently from HTTP traffic. Started via:
 *
 *   REDIS_URL=redis://... DISPATCH_WORKER_MODE=standalone npm run worker
 *
 * Set the API process to `DISPATCH_WORKER_MODE=standalone` so it
 * doesn't also start a worker — otherwise every dispatch job runs
 * twice and waves race each other.
 *
 * Single-box deploys can ignore this file entirely and let the API
 * process embed the worker (the default `DISPATCH_WORKER_MODE=embedded`).
 */

require('dotenv').config();
const env = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./config/prisma');
const redis = require('./config/redis');
const dispatcher = require('./modules/dispatch/dispatcher');
const dispatchQueue = require('./modules/dispatch/queue');

if (!dispatchQueue.enabled()) {
  /// Without Redis the worker has nothing to consume — the legacy
  /// in-process dispatch path is the only one wired in that case.
  /// Better to fail loud than to spin a no-op process forever.
  logger.error('Dispatch worker requires REDIS_URL to be set. Exiting.');
  process.exit(1);
}

dispatcher.start();
logger.info(`Dispatch worker process started (NODE_ENV=${env.NODE_ENV})`);

const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down dispatch worker...`);
  await dispatcher.stop();
  await prisma.$disconnect();
  if (redis) await redis.quit().catch(() => {});
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Worker unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Worker uncaught exception:', err);
  process.exit(1);
});
