const prisma = require('../../config/prisma');
const logger = require('../../config/logger');

/// Notifications are transient — once they're a week old nobody acts on
/// them, and keeping them forever bloats the table and the bell badge.
/// We hard-delete admin + partner notifications older than this many
/// days. Run from the repeatable `notification_cleanup` dispatch job
/// (every few hours) and once on worker boot.
const RETENTION_DAYS = 7;

/// OTPs are single-use and short-lived (a few minutes). Once they're well
/// past expiry nobody can verify against them, so we hard-delete rows whose
/// `expiresAt` is older than this. Kept short — just long enough to leave a
/// brief audit/debug trail — since the table is high-churn.
const OTP_RETENTION_DAYS = 1;

const pruneExpired = async (days = RETENTION_DAYS) => {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const otpCutoff = new Date(Date.now() - OTP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [admin, partner, otp] = await Promise.all([
    prisma.adminNotification.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.partnerNotification.deleteMany({ where: { createdAt: { lt: cutoff } } }),
    prisma.otp.deleteMany({ where: { expiresAt: { lt: otpCutoff } } }),
  ]);
  const total = admin.count + partner.count + otp.count;
  if (total > 0) {
    logger.info(
      `cleanup: removed ${total} stale rows ` +
        `(adminNotif=${admin.count} older than ${days}d, ` +
        `partnerNotif=${partner.count} older than ${days}d, ` +
        `otp=${otp.count} expired >${OTP_RETENTION_DAYS}d)`,
    );
  }
  return { admin: admin.count, partner: partner.count, otp: otp.count, cutoff };
};

module.exports = { pruneExpired, RETENTION_DAYS, OTP_RETENTION_DAYS };
