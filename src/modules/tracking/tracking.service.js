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
/// Mirror an on-duty PRESENCE coordinate into the DB so
/// `partner.currentLat/Lng` stays fresh BETWEEN jobs — not just during
/// an active booking (which is what `postLocation` covers). Without
/// this, the DB position freezes wherever a partner finished their last
/// job, and the admin "nearby partners" view + the accept-time radius
/// fallback would read that stale point after the partner moved on.
///
/// Throttled to ~once/60s per partner via the Redis gate so the 15s
/// presence cadence doesn't translate into a DB write every 15s.
/// Best-effort and unconditional on active-job state — this is the
/// "where is this on-duty partner right now" signal. Swallows errors:
/// a failed mirror must never break presence registration.
exports.mirrorPresenceLocation = async ({ partnerId, lat, lng }) => {
  const registry = require('../dispatch/registry');
  if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;
  try {
    if (!(await registry.shouldMirrorLocation(partnerId))) return;
    await prisma.partner.update({
      where: { id: Number(partnerId) },
      data: { currentLat: Number(lat), currentLng: Number(lng), lastLocationAt: new Date() },
      select: { id: true },
    });
    /// A presence write means the partner is on duty — mirror that to
    /// the queryable DB column (change-only, so this is a no-op write on
    /// the common case where they were already marked on duty).
    void exports.mirrorOnDuty({ partnerId, onDuty: true });
  } catch {
    /* best-effort — never block presence on a mirror write */
  }
};

/// Mirror the partner's duty state into the queryable DB columns
/// (`onDuty` boolean + `dutyState` 3-state). The AUTHORITATIVE source
/// stays in Redis; this keeps the DB readable for ops/SQL + the admin
/// list. Gated by `shouldMirrorDuty` so we only write on an actual on↔off
/// transition, never on every 15s presence ping.
///
/// `dutyState`:
///   off → 'off_duty'
///   on  → 'busy' if the partner is currently on a job (Redis
///         `partner:active` flag), else 'available'. This keeps a
///         partner who's working from being re-flagged "free" by a
///         presence ping mid-job.
/// Best-effort — a failed mirror must never break the duty flow.
exports.mirrorOnDuty = async ({ partnerId, onDuty }) => {
  const registry = require('../dispatch/registry');
  try {
    if (!(await registry.shouldMirrorDuty(Number(partnerId), Boolean(onDuty)))) return;
    let dutyState = 'off_duty';
    if (onDuty) {
      const busy = await registry.isOnActiveJob(Number(partnerId)).catch(() => false);
      dutyState = busy ? 'busy' : 'available';
    }
    await prisma.partner.update({
      where: { id: Number(partnerId) },
      data: { onDuty: Boolean(onDuty), dutyState, onDutyChangedAt: new Date() },
      select: { id: true },
    });
  } catch {
    /* best-effort — never block presence / duty on a mirror write */
  }
};

/// Directly set the free↔busy transition WITHIN on-duty, called from the
/// booking flow when a partner accepts a job (busy) or finishes/cancels
/// it (free again). Best-effort.
///   busy=true  → 'busy' + onDuty=true (a partner on a job IS on duty).
///   busy=false → back to 'available' IF still on duty; but if they've
///                since gone off duty (explicit off-duty flag set), put
///                them at 'off_duty' instead of wrongly re-marking them
///                free. We check the Redis off-duty flag for that.
exports.setBusyState = async ({ partnerId, busy }) => {
  const registry = require('../dispatch/registry');
  try {
    let onDuty = true;
    let dutyState = 'busy';
    if (!busy) {
      const offDuty = await registry.isOffDuty(Number(partnerId)).catch(() => false);
      onDuty = !offDuty;
      dutyState = offDuty ? 'off_duty' : 'available';
    }
    await prisma.partner.update({
      where: { id: Number(partnerId) },
      data: { onDuty, dutyState, onDutyChangedAt: new Date() },
      select: { id: true },
    });
  } catch {
    /* best-effort — never block accept/complete on a mirror write */
  }
};

exports.setDuty = async ({ partnerId, onDuty, lat, lng }) => {
  const registry = require('../dispatch/registry');
  /// Need category for the geo set, plus the DB last-known position as a
  /// fallback when the app didn't include coords in the toggle.
  const partner = await prisma.partner.findUnique({
    where: { id: Number(partnerId) },
    select: { categoryId: true, currentLat: true, currentLng: true },
  });

  if (onDuty) {
    await registry.clearOffDuty(Number(partnerId));
    /// STICKY register into the dispatch pool right now, with a long TTL,
    /// so the partner stays matchable while the app is backgrounded and
    /// pings have paused (OEM JS-thread freeze). Use the coords the app
    /// sent, else the DB's last-known position. Live presence pings will
    /// refresh the position as they move. If we have no coordinate at
    /// all, we skip — the next live ping registers them normally.
    const useLat = lat ?? partner?.currentLat ?? null;
    const useLng = lng ?? partner?.currentLng ?? null;
    if (partner?.categoryId != null && useLat != null && useLng != null) {
      await registry.setStickyOnline({
        partnerId: Number(partnerId),
        categoryId: partner.categoryId,
        lat: Number(useLat),
        lng: Number(useLng),
      });
    }
    /// Remember this as the partner's last-known position too, so the
    /// next reconcile / nearby query has it even before a live ping.
    if (useLat != null && useLng != null) {
      await prisma.partner
        .update({
          where: { id: Number(partnerId) },
          data: { currentLat: Number(useLat), currentLng: Number(useLng), lastLocationAt: new Date() },
          select: { id: true },
        })
        .catch(() => {});
    }
  } else {
    await registry.setOffDuty({
      partnerId: Number(partnerId),
      categoryId: partner?.categoryId ?? null,
    });
  }

  /// Mirror the explicit toggle to the queryable DB column. This is the
  /// authoritative duty action, so reflect it right away (change-gated
  /// inside mirrorOnDuty). Fire-and-forget — never block the toggle.
  void exports.mirrorOnDuty({ partnerId: Number(partnerId), onDuty: Boolean(onDuty) });

  return { partnerId: Number(partnerId), onDuty: Boolean(onDuty) };
};

exports.getForBooking = async ({ customerId, bookingId }) => {
  const booking = await prisma.booking.findUnique({
    where: { id: Number(bookingId) },
    select: {
      id: true,
      customerId: true,
      status: true,
      arrivedAt: true,
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
      arrivedAt: booking.arrivedAt ?? null,
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
    arrivedAt: booking.arrivedAt ?? null,
  };
};
