const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const { verifyToken } = require('../../utils/jwt');
const prisma = require('../../config/prisma');
const env = require('../../config/env');
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
///   - numeric partnerId → the `partner:{id}` room
///   - 'customer:{id}'   → a per-customer room on the customers namespace
///
/// Both go through ROOMS rather than per-socket ids so the Redis adapter
/// (when enabled) routes the emit to whichever instance actually holds
/// the target's socket. This is what makes multi-instance delivery work
/// — a partner connected to instance B still receives a `dispatch.offer`
/// emitted from instance A.
const emit = (event, target, payload) => {
  if (!io) return;
  if (typeof target === 'number') {
    io.of('/partners').to(`partner:${target}`).emit(event, payload);
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
    /// websockets natively. Cuts a bunch of HTTP-poll noise. (Also means
    /// no sticky-session requirement at the load balancer: the websocket
    /// stays pinned to one instance for its lifetime after the upgrade.)
    transports: ['websocket'],
  });

  /// Multi-instance fan-out. With the Redis adapter, a room emit on ANY
  /// instance (e.g. `dispatch.offer` to `partner:42`) reaches that
  /// partner's socket wherever it lives — so we can run N API instances
  /// behind a load balancer and still deliver every event. Without it,
  /// emits only reach sockets on the local process (fine for a single
  /// instance, which is exactly the fallback when REDIS_URL is unset).
  if (env.REDIS_URL) {
    try {
      const pubClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
      const subClient = pubClient.duplicate();
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.io: Redis adapter enabled — multi-instance fan-out ready');
    } catch (err) {
      logger.warn(`Socket.io: Redis adapter setup failed, single-instance only: ${err.message}`);
    }
  }

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
    /// Join the per-partner room so the Redis adapter can route emits to
    /// this socket from any instance, and bump the cross-instance live-
    /// socket counter so the dispatcher knows this partner is reachable.
    socket.join(`partner:${partnerId}`);
    await registry.incrSocketConn(partnerId).catch(() => {});

    /// Resolve the partner's dispatch-relevant fields ONCE, here, instead
    /// of on every presence ping. At 5k on-duty partners pinging ~every
    /// 15s, a per-ping `findUnique` was ~350 DB queries/sec of pure
    /// overhead; category / active / verified barely change within a
    /// session, so caching them on the socket removes that load entirely.
    /// (A mid-session suspend forces the app off-duty + a reconnect,
    /// which re-runs this lookup.)
    try {
      const partner = await prisma.partner.findUnique({
        where: { id: partnerId },
        select: { categoryId: true, isActive: true, isVerified: true },
      });
      socket.data.categoryId = partner?.categoryId ?? null;
      socket.data.dispatchable =
        !!partner?.isActive && !!partner?.isVerified && partner?.categoryId != null;
    } catch (err) {
      socket.data.dispatchable = false;
      logger.warn(`socket connect lookup failed for partner ${partnerId}: ${err.message}`);
    }

    /// Opening a socket is itself an authoritative "I'm on duty" signal:
    /// the partner app only connects the socket when the duty toggle is
    /// ON. Clear any lingering off-duty guard flag here so the first
    /// presence ping isn't rejected by `upsertOnline` — this avoids a
    /// race with the slower HTTP `POST /tracking/me/duty` call the app
    /// fires in parallel when toggling on. (Going off duty disconnects
    /// the socket, so no connect happens to wrongly clear the flag.)
    if (socket.data.dispatchable) {
      await registry.clearOffDuty(partnerId).catch(() => {});
    }

    /// We don't GEOADD on connect — connect doesn't carry coords.
    /// First `presence` event with a location flips the partner into
    /// the online registry. Until then they're "connected but not
    /// dispatchable", which is the right state for someone whose app
    /// is still resolving GPS.
    socket.on('presence', async (msg) => {
      const lat = Number(msg?.lat);
      const lng = Number(msg?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      /// No DB hit on the hot path — read the cached fields set on
      /// connect. Refresh the socket-conn TTL so a long-lived socket's
      /// counter doesn't expire under it.
      if (!socket.data.dispatchable || socket.data.categoryId == null) return;
      try {
        await registry.upsertOnline({
          partnerId,
          categoryId: socket.data.categoryId,
          lat,
          lng,
        });
        await registry.touchSocketConn(partnerId).catch(() => {});
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
      removePartnerSocket(partnerId, socket.id); // local stats only
      /// Decrement the CROSS-INSTANCE counter — only pull the partner out
      /// of the online registry when their last socket anywhere is gone.
      /// (The old `wasLast` was per-instance, so on a multi-instance
      /// deploy it would have wrongly marked a partner offline while they
      /// still had a socket on another box.)
      const remaining = await registry.decrSocketConn(partnerId).catch(() => 0);
      if (remaining <= 0 && socket.data.categoryId != null) {
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
  /// (Live-socket presence is now tracked in Redis by the connect/
  /// disconnect handlers above; the dispatcher reads it directly via the
  /// registry — no in-memory checker injection needed, which also makes
  /// it correct across instances.)
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
