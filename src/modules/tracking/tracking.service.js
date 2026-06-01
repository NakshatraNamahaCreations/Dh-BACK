const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

/**
 * Live-location tracking — phase 1: REST data path.
 *
 * Two operations:
 *   - postLocation()  partner-only, called every ~12s from the partner
 *                     app while the partner has an accepted booking
 *                     in (CONFIRMED, IN_PROGRESS). Writes a single row
 *                     update to `partners` (currentLat/currentLng/
 *                     lastLocationAt) — that's the durable truth.
 *   - getForBooking() customer-only, called by the customer app on a
 *                     poll loop while their booking is in flight.
 *                     Returns the partner's last reported coordinates
 *                     plus a freshness timestamp so the client can
 *                     stop polling / show "last seen X minutes ago"
 *                     if the partner-app died.
 *
 * Why no history table here: the customer-app only ever needs the
 * latest point, and the partner-side breadcrumb-trail use cases
 * (audit, ETA modelling, fraud) aren't on the roadmap yet. When they
 * arrive, add a `partner_locations` append-only table — the column on
 * `Partner` stays as the fast read path.
 *
 * Phase 2 (websocket push) plugs in here: after the column write,
 * emit a `partner-location` event to the booking's room. The REST
 * read remains the durable fallback for clients that just connected.
 */

/// We accept location updates only when the partner has an accepted
/// booking that's still in flight — otherwise a partner whose app
/// stayed open in the background would keep posting stale GPS forever.
/// Returns the booking id (or null) so the broadcast layer can scope
/// emitted events to a specific room when phase 2 lands.
const findActiveBookingId = async (partnerId) => {
  const active = await prisma.booking.findFirst({
    where: {
      partnerId: Number(partnerId),
      status: { in: ['CONFIRMED', 'IN_PROGRESS'] },
    },
    orderBy: { updatedAt: 'desc' },
    select: { id: true },
  });
  return active?.id ?? null;
};

exports.postLocation = async ({ partnerId, lat, lng, accuracy }) => {
  /// Gate on having an active accepted booking. Without this, every
  /// partner with the app open in the background would keep writing
  /// to `partners.currentLat/Lng`, which (a) wastes battery + DB
  /// writes and (b) muddies the "where is this partner right now"
  /// answer for the dispatch / nearby-partners query.
  const activeBookingId = await findActiveBookingId(partnerId);
  if (!activeBookingId) {
    throw ApiError.badRequest('No active booking — location updates are paused.');
  }

  const updated = await prisma.partner.update({
    where: { id: Number(partnerId) },
    data: {
      currentLat: lat,
      currentLng: lng,
      lastLocationAt: new Date(),
    },
    select: { id: true, currentLat: true, currentLng: true, lastLocationAt: true },
  });

  return {
    partnerId: updated.id,
    lat: updated.currentLat,
    lng: updated.currentLng,
    lastLocationAt: updated.lastLocationAt,
    bookingId: activeBookingId,
    accuracy: accuracy ?? null,
  };
};

/// Explicit On Duty / Off Duty toggle from the partner app. This is the
/// AUTHORITATIVE duty signal the dispatcher was previously missing —
/// before this, the server only inferred availability from socket
/// presence + a 90s TTL, so a socket reconnect (e.g. after a device
/// location change) could silently re-register an off-duty partner and
/// they'd keep getting offers. Now:
///
///   OFF → set the `partner:offduty` guard flag AND immediately remove
///         the partner from the online geo set, so dispatch stops
///         offering to them within one round-trip (not after 90s). The
///         flag makes every presence path (socket ping, legacy poll,
///         background task) refuse to re-add them.
///   ON  → clear the flag so the app's next presence ping re-registers
///         them as available.
///
/// Best-effort against Redis — if Redis is down the registry helpers
/// no-op and we still return success (presence-based behaviour is the
/// fallback, same as before this endpoint existed).
exports.setDuty = async ({ partnerId, onDuty }) => {
  const registry = require('../dispatch/registry');
  /// Look up the partner's category so the OFF path can ZREM them from
  /// the right per-category online set immediately. Not load-bearing
  /// (the off-duty flag + lastseen-liveness filter already block
  /// offers) but it keeps the geo set clean rather than waiting for the
  /// next sweep.
  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: { categoryId: true },
  });

  if (onDuty) {
    await registry.clearOffDuty(Number(partnerId));
  } else {
    await registry.setOffDuty({
      partnerId: Number(partnerId),
      categoryId: partner?.categoryId ?? null,
    });
  }

  return { partnerId: Number(partnerId), onDuty: Boolean(onDuty) };
};

exports.getForBooking = async ({ customerId, bookingId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: {
      id: true,
      customerId: true,
      status: true,
      lat: true,
      lng: true,
      partner: {
        select: {
          id: true,
          name: true,
          businessName: true,
          phone: true,
          currentLat: true,
          currentLng: true,
          lastLocationAt: true,
        },
      },
    },
  });
  if (!booking) throw ApiError.notFound('Booking not found');
  if (booking.customerId !== Number(customerId)) {
    throw ApiError.forbidden('Not your booking');
  }

  /// Tracking is meaningful only while the partner is active.
  /// Returning explicit nulls outside that window so the client can
  /// stop its poll loop instead of guessing from an old timestamp.
  const isLive = ['CONFIRMED', 'IN_PROGRESS'].includes(booking.status);
  const partner = booking.partner;
  if (!isLive || !partner || partner.currentLat == null || partner.currentLng == null) {
    return {
      bookingId: booking.id,
      status: booking.status,
      partner: partner
        ? {
            id: partner.id,
            name: partner.name ?? partner.businessName ?? null,
            phone: partner.phone,
          }
        : null,
      destination:
        booking.lat != null && booking.lng != null
          ? { lat: booking.lat, lng: booking.lng }
          : null,
      partnerLocation: null,
      lastLocationAt: partner?.lastLocationAt ?? null,
    };
  }

  return {
    bookingId: booking.id,
    status: booking.status,
    partner: {
      id: partner.id,
      name: partner.name ?? partner.businessName ?? null,
      phone: partner.phone,
    },
    /// Customer needs to know where the partner is heading TOWARDS
    /// to draw the polyline / compute their own ETA preview. The
    /// destination is the booking's address snapshot — denormalised
    /// at booking time so it's stable.
    destination:
      booking.lat != null && booking.lng != null
        ? { lat: booking.lat, lng: booking.lng }
        : null,
    partnerLocation: { lat: partner.currentLat, lng: partner.currentLng },
    lastLocationAt: partner.lastLocationAt,
  };
};
