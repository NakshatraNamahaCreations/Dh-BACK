const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');

/**
 * Admin-side notifications. Companion to `notifications.service.js`
 * (which is partner-side) — they're kept in the same module so all
 * notification logic is in one place, even though they write to
 * different tables and are consumed by different surfaces.
 *
 * Notable design choices:
 *   • One row per admin per event (matches PartnerNotification's
 *     shape). Means `notifyAllAdmins` fans out N inserts. Cheap at
 *     <20 admins; revisit if the team grows.
 *   • Writes NEVER throw — a notification failing should not block
 *     the underlying business action (booking create, payment
 *     verify, etc.) that fired it. Callers `await` without try/catch.
 *   • No socket emission yet — admin panel polls /admins/me/notifications
 *     every ~30s. Swap to a socket later if needed.
 */

/// Notification type catalogue — kept as plain strings (not an enum)
/// so adding new types doesn't require a migration. The admin panel
/// renders unknown types with a generic icon.
const TYPES = {
  BOOKING_NEW: 'booking_new',
  BOOKING_DISPATCH_NEEDED: 'booking_dispatch_needed',
  PARTNER_SIGNUP: 'partner_signup',
  PAYMENT_FAILED: 'payment_failed',
  REFUND_PENDING: 'refund_pending',
  ACCOUNT_DELETION_REQUEST: 'account_deletion_request',
  DISPUTE_RAISED: 'dispute_raised',
  SYSTEM: 'system',
};
exports.TYPES = TYPES;

/// Insert one notification per active admin. Used by every domain
/// event handler that wants to surface something in the bell.
///
/// Soft-fail philosophy: if the inserts throw, log and move on.
/// The notification is best-effort UI — losing one shouldn't roll
/// back a booking creation.
exports.notifyAllAdmins = async ({
  type,
  title,
  body,
  href = null,
  bookingId = null,
  partnerId = null,
  customerId = null,
} = {}) => {
  if (!type || !title || !body) {
    logger.warn(
      `[admin-notifications] missing fields: type=${type} title=${!!title} body=${!!body}`,
    );
    return null;
  }
  try {
    /// Pull only ACTIVE admins. A deactivated admin's row stays in the
    /// `admins` table (soft-delete), but they don't need new bell items.
    const admins = await prisma.admin.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    if (admins.length === 0) return null;

    const data = admins.map((a) => ({
      adminId: a.id,
      type: String(type),
      title: String(title),
      body: String(body),
      href: href ? String(href) : null,
      bookingId: bookingId != null ? Number(bookingId) : null,
      partnerId: partnerId != null ? Number(partnerId) : null,
      customerId: customerId != null ? Number(customerId) : null,
    }));
    await prisma.adminNotification.createMany({ data });
    return { count: data.length };
  } catch (err) {
    logger.warn(`[admin-notifications] notifyAllAdmins failed: ${err.message}`);
    return null;
  }
};

const shape = (row) => ({
  id: String(row.id),
  type: row.type,
  title: row.title,
  body: row.body,
  href: row.href ?? null,
  bookingId: row.bookingId != null ? String(row.bookingId) : null,
  partnerId: row.partnerId != null ? String(row.partnerId) : null,
  customerId: row.customerId != null ? String(row.customerId) : null,
  timestamp: row.createdAt.toISOString(),
  read: row.readAt != null,
});

exports.listForAdmin = async (adminId, { limit = 50, before } = {}) => {
  const where = { adminId: Number(adminId) };
  if (before) where.createdAt = { lt: new Date(before) };
  const rows = await prisma.adminNotification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200),
  });
  return rows.map(shape);
};

exports.unreadCount = async (adminId) =>
  prisma.adminNotification.count({
    where: { adminId: Number(adminId), readAt: null },
  });

exports.markRead = async (adminId, notificationId) => {
  const row = await prisma.adminNotification.findUnique({
    where: { id: Number(notificationId) },
  });
  if (!row) throw ApiError.notFound('Notification not found');
  if (row.adminId !== Number(adminId)) {
    throw ApiError.forbidden('Not your notification');
  }
  if (row.readAt) return shape(row);
  const updated = await prisma.adminNotification.update({
    where: { id: row.id },
    data: { readAt: new Date() },
  });
  return shape(updated);
};

exports.markAllRead = async (adminId) => {
  await prisma.adminNotification.updateMany({
    where: { adminId: Number(adminId), readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
};

exports.remove = async (adminId, notificationId) => {
  const row = await prisma.adminNotification.findUnique({
    where: { id: Number(notificationId) },
  });
  if (!row) throw ApiError.notFound('Notification not found');
  if (row.adminId !== Number(adminId)) {
    throw ApiError.forbidden('Not your notification');
  }
  await prisma.adminNotification.delete({ where: { id: row.id } });
  return { ok: true };
};

exports.clearAll = async (adminId) => {
  await prisma.adminNotification.deleteMany({
    where: { adminId: Number(adminId) },
  });
  return { ok: true };
};
