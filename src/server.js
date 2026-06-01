require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const app = require('./app');
const env = require('./config/env');
const logger = require('./config/logger');
const prisma = require('./config/prisma');
const redis = require('./config/redis');
const dispatcher = require('./modules/dispatch/dispatcher');
const dispatchQueue = require('./modules/dispatch/queue');
const dispatchSocket = require('./modules/dispatch/socket');

/// Wrap the Express app in a real `http.Server` so Socket.io can
/// share the same listener. `app.listen()` does this internally; we
/// just need the handle so the gateway can attach.
const server = http.createServer(app);

if (dispatchQueue.enabled()) {
  /// In `standalone` mode a separate `npm run worker` process consumes
  /// the queue — the API process must NOT also run a worker, otherwise
  /// you'd double-process every dispatch job. The Socket.io gateway
  /// stays here in either mode because that's what API clients
  /// connect to.
  if (env.DISPATCH_WORKER_MODE === 'embedded') {
    dispatcher.start();
    logger.info('Dispatch: embedded mode (worker runs in API process)');
  } else {
    logger.info('Dispatch: standalone mode (expecting separate worker process)');
  }
  dispatchSocket.start(server);
} else {
  /// REDIS_URL not set — the legacy poll-driven dispatch path inside
  /// bookings.service is still wired and handles everything. Logged
  /// once at boot so this state is obvious in the console.
  logger.info('Dispatch: legacy mode (set REDIS_URL to enable push dispatch)');
}

server.listen(env.PORT, () => {
  logger.info(`Server running in ${env.NODE_ENV} mode on port ${env.PORT}`);
});

const shutdown = async (signal) => {
  logger.info(`${signal} received. Shutting down gracefully...`);
  /// Close the socket gateway BEFORE the HTTP server so in-flight
  /// websocket frames have a chance to drain. Order matters: dispatcher
  /// stop also flushes BullMQ workers; we want them to finish before
  /// disconnecting from Postgres.
  await dispatchSocket.stop();
  await dispatcher.stop();
  server.close(async () => {
    await prisma.$disconnect();
    /// `quit()` flushes pending commands and closes the socket cleanly;
    /// without it the process can hang for ioredis's reconnect timer.
    /// Skipped when Redis was never enabled (`redis === null`).
    if (redis) await redis.quit().catch(() => {});
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
  process.exit(1);
});
