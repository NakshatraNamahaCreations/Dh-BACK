const { PrismaClient } = require('@prisma/client');
const env = require('./env');

/**
 * Connection-pool sizing.
 *
 * Prisma's pool defaults to `num_cpus * 2 + 1` (~5–9 on a small box).
 * Under high concurrent load — presence pings, the incoming poll, and
 * dispatch all share this pool — that default throttles hard and causes
 * "Timed out fetching a connection" errors. `DB_CONNECTION_LIMIT` lets
 * ops size the pool per instance without editing the URL secret.
 *
 * Multi-instance caution: total open connections = DB_CONNECTION_LIMIT ×
 * instance_count, and that MUST stay under the RDS `max_connections` for
 * the chosen instance class (a small RDS allows ~80–100). For many
 * instances, front Postgres with PgBouncer and point DATABASE_URL at it.
 */
const buildDatasourceUrl = () => {
  const base = process.env.DATABASE_URL;
  const limit = process.env.DB_CONNECTION_LIMIT;
  if (!base || !limit) return null;
  try {
    const u = new URL(base);
    u.searchParams.set('connection_limit', String(parseInt(limit, 10)));
    return u.toString();
  } catch {
    return null;
  }
};

const datasourceUrl = buildDatasourceUrl();

const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  ...(datasourceUrl ? { datasources: { db: { url: datasourceUrl } } } : {}),
});

/// Transient connection errors that are safe to retry — the DB/network
/// blipped, not a query problem. Prisma surfaces these as known error
/// codes; we also match the raw text for cases where the error isn't
/// wrapped in a PrismaClientKnownRequestError (e.g. pool-acquire
/// timeouts during a reconnect).
///
///   P1001 — can't reach database server
///   P1017 — server has closed the connection
///   P1008 — operation timed out (often a stuck/recovering connection)
///   P2024 — timed out fetching a connection from the pool
const TRANSIENT_DB_CODES = new Set(['P1001', 'P1017', 'P1008', 'P2024']);
const isTransientDbError = (err) => {
  if (!err) return false;
  if (err.code && TRANSIENT_DB_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return (
    msg.includes("Can't reach database server") ||
    msg.includes('Server has closed the connection') ||
    msg.includes('Timed out fetching a connection') ||
    msg.includes('Connection terminated') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT')
  );
};

/// Run a DB operation, retrying on a transient connection error. RDS /
/// NAT idle-timeouts silently kill an idle connection; the first query
/// after that fails with P1001 before Prisma's pool reconnects. A short
/// retry (after a pause for the pool to re-establish) turns those one-off
/// blips into a non-event — which is exactly what the mostly-idle
/// dispatch worker's recurring jobs hit. Non-transient errors (real
/// query bugs, constraint violations) re-throw immediately so we never
/// mask actual problems.
const withDbRetry = async (op, { retries = 2, delayMs = 500, label = 'db op' } = {}) => {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt < retries && isTransientDbError(err)) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

module.exports = prisma;
module.exports.withDbRetry = withDbRetry;
module.exports.isTransientDbError = isTransientDbError;
