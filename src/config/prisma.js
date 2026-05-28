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

module.exports = prisma;
