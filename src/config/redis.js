const Redis = require('ioredis');
const env = require('./env');
const logger = require('./logger');

/// Single shared ioredis client. Returns `null` when REDIS_URL is unset
/// — the cache helper checks for null and short-circuits to a no-op,
/// so callers don't have to branch between "redis available" and
/// "redis disabled" themselves.
///
/// Connection options:
///  - `lazyConnect: false` so the client connects on construction; if
///    the URL is bad we discover it at boot, not on the first request.
///  - `maxRetriesPerRequest: 1` so a transient blip surfaces quickly
///    rather than queueing a request behind 20+ silent retries.
///  - `enableOfflineQueue: false` so commands issued while disconnected
///    fail fast (the cache helper treats these as cache misses) instead
///    of stalling the API call.
///
/// All errors are logged at warn — the API keeps working without
/// Redis; performance just falls back to direct DB reads.
let client = null;

if (env.REDIS_URL) {
  client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: false,
  });

  client.on('connect', () => logger.info('Redis: connected'));
  client.on('ready', () => logger.info('Redis: ready'));
  client.on('error', (err) => {
    /// `error` fires on every reconnect attempt while Redis is down,
    /// so we throttle to warn (not error) to avoid log spam.
    logger.warn(`Redis: ${err.message}`);
  });
  client.on('end', () => logger.info('Redis: connection closed'));
} else {
  logger.info('Redis: disabled (REDIS_URL not set) — cache layer is a no-op');
}

module.exports = client;
