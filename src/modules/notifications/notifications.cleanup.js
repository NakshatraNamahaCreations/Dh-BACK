const prisma = require('../../config/prisma');
const logger = require('../../config/logger');

/// Notifications are transient — once they're a week old nobody acts on
/// them, and keeping them forever bloats the table and the bell badge.
/// We hard-delete admin + partner notifications older than this many
/// days. Run from the repeatable `notification_cleanup` dispatch job
/// (every few hours) and once on worker boot.
const RETENTION_DAYS = 7;

const pruneExpired = async (days = RETENTION_DAYS) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const [admin, partner] = await Promise.all([
    prisma.adminNotification.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.partnerNotification.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ]);
  const total = admin.count + partner.count;
  if (total > 0) {
    logger.info(
      `notification cleanup: removed ${total} older than ${days}d ` +
        `(admin=${admin.count}, partner=${partner.count})`,
    );
  }
  return { admin: admin.count, partner: partner.count, cutoff };
};

module.exports = { pruneExpired, RETENTION_DAYS };
