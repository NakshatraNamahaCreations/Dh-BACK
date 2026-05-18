const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');

/**
 * Partner notifications service.
 *
 * Writes are called from the rest of the codebase at lifecycle events
 * (booking completed, account suspended, KYC verified, onboarding fee
 * paid, admin-assigned job, payout settled). Reads are called by the
 * partner-app via /partners/me/notifications.
 *
 * Every successful `create` also pushes a `notification.new` socket
 * event to the partner so the bell badge updates without polling.
 * The socket emitter is wired by dispatch/socket.js at server boot
 * (it shares the same emit hook the dispatcher uses).
 */

/// Socket emit hook — set by dispatch/socket.js.start(). Signature
/// matches the one used by dispatcher: emit(event, target, payload),
/// where target is a numeric partnerId.
let emit = null;
exports.setSocketEmitter = (fn) => {
  emit = typeof fn === 'function' ? fn : null;
};

/// Write a notification row + push over socket. All emission call sites
/// use this — DON'T write directly to the table elsewhere.
///
/// Wrapped in try/catch with a logger.warn fallback: a notification
/// failure should NEVER block the underlying business action (we don't
/// want a booking completion to roll back because the row insert hit
/// a DB hiccup). Callers can safely await without try/catch.
exports.create = async ({ partnerId, type, title, body, bookingId } = {}) => {
  if (!partnerId || !type || !title || !body) {
    logger.warn(
      `[notifications] missing fields: partnerId=${partnerId} type=${type} title=${!!title} body=${!!body}`,
    );
    return null;
  }
  try {
    const row = await prisma.partnerNotification.create({
      data: {
        partnerId: Number(partnerId),
        type: String(type),
        title: String(title),
        body: String(body),
        bookingId: bookingId != null ? Number(bookingId) : null,
      },
    });
    if (emit) {
      emit('notification.new', Number(partnerId), {
        id: String(row.id),
        type: row.type,
        title: row.title,
        body: row.body,
        bookingId: row.bookingId != null ? String(row.bookingId) : null,
        timestamp: row.createdAt.toISOString(),
        read: false,
      });
    }
    return row;
  } catch (err) {
    logger.warn(`[notifications] create failed for partner ${partnerId}: ${err.message}`);
    return null;
  }
};

const shape = (row) => ({
  id: String(row.id),
  type: row.type,
  title: row.title,
  body: row.body,
  bookingId: row.bookingId != null ? String(row.bookingId) : null,
  timestamp: row.createdAt.toISOString(),
  read: row.readAt != null,
});

/// Paginated list, newest-first. Default page size 50 — covers the
/// typical scroll without making the partner-app implement pagination
/// for what's almost always a short list.
exports.listForPartner = async (partnerId, { limit = 50, before } = {}) => {
  const where = { partnerId: Number(partnerId) };
  if (before) {
    where.createdAt = { lt: new Date(before) };
  }
  const rows = await prisma.partnerNotification.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: Math.min(Number(limit) || 50, 200),
  });
  return rows.map(shape);
};

exports.unreadCount = async (partnerId) =>
  prisma.partnerNotification.count({
    where: { partnerId: Number(partnerId), readAt: null },
  });

exports.markRead = async (partnerId, notificationId) => {
  const row = await prisma.partnerNotification.findUnique({
    where: { id: Number(notificationId) },
  });
  if (!row) throw ApiError.notFound('Notification not found');
  if (row.partnerId !== Number(partnerId)) {
    throw ApiError.forbidden('Not your notification');
  }
  if (row.readAt) return shape(row);
  const updated = await prisma.partnerNotification.update({
    where: { id: row.id },
    data: { readAt: new Date() },
  });
  return shape(updated);
};

exports.markAllRead = async (partnerId) => {
  await prisma.partnerNotification.updateMany({
    where: { partnerId: Number(partnerId), readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true };
};

exports.remove = async (partnerId, notificationId) => {
  const row = await prisma.partnerNotification.findUnique({
    where: { id: Number(notificationId) },
  });
  if (!row) throw ApiError.notFound('Notification not found');
  if (row.partnerId !== Number(partnerId)) {
    throw ApiError.forbidden('Not your notification');
  }
  await prisma.partnerNotification.delete({ where: { id: row.id } });
  return { ok: true };
};

exports.clearAll = async (partnerId) => {
  await prisma.partnerNotification.deleteMany({
    where: { partnerId: Number(partnerId) },
  });
  return { ok: true };
};
