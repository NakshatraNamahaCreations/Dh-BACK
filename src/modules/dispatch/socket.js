const { Server } = require('socket.io');
const { verifyToken } = require('../../utils/jwt');
const prisma = require('../../config/prisma');
const logger = require('../../config/logger');
const dispatcher = require('./dispatcher');
const registry = require('./registry');
const notifications = require('../notifications/notifications.service');

/**
 * Socket.io gateway — Phase 2 push channel.
 *
 * Two audiences:
 *
 *   PARTNERS — connect to the `/partners` namespace with their JWT.
 *     We hold a `Map<partnerId, Set<socketId>>` (a partner can have
 *     multiple devices) and use it to push:
 *
 *       dispatch.offer  → "here's a new job in your radius"
 *       dispatch.claimed → "this offer was taken by someone else"
 *
 *     Partners send back:
 *
 *       presence       → location ping; GEOADD into category online set
 *       partner.accept → claim a booking (first-ack-wins)
 *
 *   CUSTOMERS — connect to `/customers` namespace. We use this to
 *     push booking lifecycle events (offer expired, partner found,
 *     partner en route, etc.) without making the cart/tracking
 *     screens poll. Implementation here is minimal for now — just
 *     the room registration; emitters land in follow-up sessions.
 *
 * The dispatcher module talks to this gateway via the
 * `setSocketEmitter` callback, which keeps the import graph acyclic
 * (dispatcher → socket would create a cycle since socket imports
 * dispatcher).
 */

let io = null;

/// partnerId → Set<socketId>. Lets us push to every active session of
/// a partner (e.g. they're logged in on phone + tablet) and clean up
/// presence only when ALL sockets disconnect.
const partnerSockets = new Map();

const addPartnerSocket = (partnerId, socketId) => {
  let set = partnerSockets.get(partnerId);
  if (!set) {
    set = new Set();
    partnerSockets.set(partnerId, set);
  }
  set.add(socketId);
};

const removePartnerSocket = (partnerId, socketId) => {
  const set = partnerSockets.get(partnerId);
  if (!set) return false;
  set.delete(socketId);
  if (set.size === 0) {
    partnerSockets.delete(partnerId);
    return true; // last socket gone — caller should clear presence
  }
  return false;
};

/// Emitter the dispatcher uses. Two address types:
///   - numeric partnerId → resolves to that partner's sockets
///   - 'customer:{id}'   → resolves to a per-customer room on the
///     customers namespace
const emit = (event, target, payload) => {
  if (!io) return;
  if (typeof target === 'number') {
    const set = partnerSockets.get(target);
    if (!set || set.size === 0) return;
    const ns = io.of('/partners');
    for (const socketId of set) {
      ns.to(socketId).emit(event, payload);
    }
    return;
  }
  if (typeof target === 'string' && target.startsWith('customer:')) {
    io.of('/customers').to(target).emit(event, payload);
  }
};

/// Mounts the Socket.io server on the given HTTP server. Returns the
/// `io` instance so server.js can keep a handle for graceful shutdown.
const start = (httpServer) => {
  if (io) return io;

  io = new Server(httpServer, {
    /// Phase 2 deliberately allows all origins — production should
    /// tighten this via env. The native partner/customer apps connect
    /// directly so CORS isn't a concern there; admin-panel and any
    /// future web partner portal would need a real allowlist.
    cors: { origin: '*' },
    /// Long-poll fallback off — every client we control supports
    /// websockets natively. Cuts a bunch of HTTP-poll noise.
    transports: ['websocket'],
  });

  /// PARTNER NAMESPACE -----------------------------------------------------
  const partnerNs = io.of('/partners');

  partnerNs.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ?? socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('Auth token required'));
      const payload = verifyToken(token);
      if (payload?.type !== 'PARTNER' || !payload?.sub) {
        return next(new Error('Partner-only namespace'));
      }
      socket.data.partnerId = Number(payload.sub);
      next();
    } catch (err) {
      next(new Error(`Auth failed: ${err.message}`));
    }
  });

  partnerNs.on('connection', async (socket) => {
    const partnerId = socket.data.partnerId;
    addPartnerSocket(partnerId, socket.id);

    /// We don't GEOADD on connect — connect doesn't carry coords.
    /// First `presence` event with a location flips the partner into
    /// the online registry. Until then they're "connected but not
    /// dispatchable", which is the right state for someone whose app
    /// is still resolving GPS.

    socket.on('presence', async (msg) => {
      const lat = Number(msg?.lat);
      const lng = Number(msg?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      try {
        const partner = await prisma.partner.findUnique({
          where: { id: partnerId },
          select: { categoryId: true, isActive: true, isVerified: true },
        });
        if (!partner?.isActive || !partner?.isVerified || !partner.categoryId) return;
        await registry.upsertOnline({
          partnerId,
          categoryId: partner.categoryId,
          lat,
          lng,
        });
        socket.data.categoryId = partner.categoryId;
      } catch (err) {
        logger.warn(`socket presence failed: ${err.message}`);
      }
    });

    /// `partner.accept` lets a partner accept directly over the socket
    /// — saves an HTTPS roundtrip on the most latency-sensitive action.
    /// We delegate to the same service method the REST endpoint uses
    /// so all the validations / claim race / queue cancellation run
    /// once, in one place.
    socket.on('partner.accept', async (msg, ack) => {
      const bookingId = Number(msg?.bookingId);
      if (!Number.isFinite(bookingId)) {
        ack?.({ ok: false, error: 'Invalid bookingId' });
        return;
      }
      try {
        /// Required late so the dispatcher → socket → bookings cycle
        /// stays unbroken (bookings.service requires dispatcher; we
        /// require bookings.service here only at call time).
        const bookingsService = require('../bookings/bookings.service');
        /// partnerAccept handles the targeted dispatch.claimed
        /// broadcast itself via dispatcher.broadcastClaimed, so the
        /// REST and socket paths fan out the same way and we don't
        /// have to duplicate the audience snapshot here.
        const accepted = await bookingsService.partnerAccept({ bookingId, partnerId });
        ack?.({ ok: true, booking: accepted });
      } catch (err) {
        ack?.({
          ok: false,
          error: err?.message ?? 'Could not accept booking',
          status: err?.status ?? 500,
        });
      }
    });

    socket.on('disconnect', async () => {
      const wasLast = removePartnerSocket(partnerId, socket.id);
      if (wasLast && socket.data.categoryId != null) {
        await registry.removeOnline({
          partnerId,
          categoryId: socket.data.categoryId,
        });
      }
    });
  });

  /// CUSTOMER NAMESPACE ----------------------------------------------------
  /// Customers connect with their JWT and auto-join `customer:{id}`.
  /// The dispatcher emits booking.expired / booking.accepted into
  /// that room so the cart and tracking screens get instant updates.
  const customerNs = io.of('/customers');

  customerNs.use((socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token ?? socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');
      if (!token) return next(new Error('Auth token required'));
      const payload = verifyToken(token);
      if (payload?.type !== 'CUSTOMER' || !payload?.sub) {
        return next(new Error('Customer-only namespace'));
      }
      socket.data.customerId = Number(payload.sub);
      next();
    } catch (err) {
      next(new Error(`Auth failed: ${err.message}`));
    }
  });

  customerNs.on('connection', (socket) => {
    socket.join(`customer:${socket.data.customerId}`);
  });

  /// Wire the dispatcher's emit hook so wave/expire jobs can push
  /// straight to the right sockets without socket.io knowledge inside
  /// the dispatcher.
  dispatcher.setSocketEmitter(emit);
  /// Same hook for the notifications service — every `create` writes
  /// a row and pushes `notification.new` to the partner so the bell
  /// badge updates instantly.
  notifications.setSocketEmitter(emit);

  logger.info('Socket.io gateway started (push channel enabled)');
  return io;
};

const stop = async () => {
  if (io) {
    await io.close().catch(() => {});
    io = null;
  }
  partnerSockets.clear();
};

module.exports = {
  start,
  stop,
  /// Exposed for tests / admin tooling — counts let you check how
  /// many partners are currently connected (a useful health-check).
  stats: () => ({
    connectedPartners: partnerSockets.size,
    totalSockets: [...partnerSockets.values()].reduce((acc, s) => acc + s.size, 0),
  }),
};
