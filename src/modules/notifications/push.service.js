const logger = require('../../config/logger');
const firebase = require('../../config/firebase');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const JOB_OFFER_PUSH_TTL_SECONDS = 190;
const JOB_OFFER_PUSH_TTL_MS = JOB_OFFER_PUSH_TTL_SECONDS * 1000;

/// MUST match `CHANNEL_ID` in partner-app/src/services/notifications.ts —
/// the MAX-importance channel (ringtone-length custom sound, strong
/// vibration, bypassDnd, public lock-screen). When an FCM message carries
/// a notification block the OS renders it on this channel, so a
/// system-rendered alert is exactly as loud as the in-app one.
const JOB_ALERT_CHANNEL_ID = 'job-alerts-v6';

/// Shared Android notification tag for ALL job-offer pushes. A new offer
/// REPLACES the previous one (no stacking), and a clear push (see
/// `clearJobOfferPush`) dismisses it when the job is taken/expired. Must
/// match the tag the partner-app uses to cancel the OS notification.
const JOB_OFFER_NOTIFICATION_TAG = 'dhoond-job-offer';

/**
 * Send an Expo push notification to a single device.
 *
 * Uses Expo's HTTP/2 push API directly (no SDK dependency). Soft-fails
 * on any error — a push failure should never block the dispatch flow.
 *
 * @param {string} token  - ExponentPushToken[...] from the partner-app
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {object} [opts.data]  - extra payload readable in the app
 */
const sendPush = async (token, { title, body, data = {} } = {}) => {
  if (!token || !token.startsWith('ExponentPushToken[')) return;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        to: token,
        title,
        body,
        data,
        sound: 'default',
        priority: 'high',
        /// MUST match `CHANNEL_ID` in partner-app/src/services/notifications.ts.
        /// Bumped from v3 → v4 → v5 → v6 alongside the client. Channel IDs
        /// are immutable on Android, so when the client bumps the channel
        /// (the v6 channel carries the strong >5s vibration pattern), the
        /// backend has to follow or pushes land in an old / non-existent
        /// channel and never alert (or vibrate) the partner.
        channelId: 'job-alerts-v6',
        /// 190s = the full dispatch window (six 30s attempts with five
        /// 2s gaps — see DISPATCH_TOTAL_MS in dispatch/dispatcher.js).
        /// A device in a Doze
        /// maintenance gap can be unreachable for more than a minute; the
        /// old 60s TTL meant FCM/Expo discarded the offer before the phone
        /// next woke, so the partner never saw a job that was still live.
        /// Matching the dispatch window means the offer is delivered for as
        /// long as it could still be accepted, and no longer (a stale accept
        /// past expiry is rejected gracefully via `dispatch.claimed`).
        ttl: JOB_OFFER_PUSH_TTL_SECONDS,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn(`[push] Expo API ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    logger.warn(`[push] sendPush failed for token ...${token.slice(-8)}: ${err.message}`);
  }
};

/**
 * Send a direct FCM message to a single device.
 *
 * Two modes, picked by whether a `notification` copy is passed:
 *
 *   - Data-only (notification omitted): wakes the partner-app's JS
 *     background handler, which fires the notifee full-screen alert.
 *     Only works while the OS will run the handler — i.e. the process is
 *     alive or wake-able.
 *
 *   - Hybrid (notification supplied): attaches a `notification` block so
 *     the OS renders the alert ITSELF, even when the app process has been
 *     frozen / killed by an OEM battery manager or deep Doze — the state
 *     where the background handler can't run and a data-only message
 *     would show nothing at all. Trade-off: when a notification block is
 *     present, FCM does NOT invoke the background handler, so the
 *     callers send the hybrid form only to partners WITHOUT a live socket
 *     (the connected ones already get the rich in-app alert over the
 *     socket — see the dispatcher). The notification lands on the
 *     MAX-importance `job-alerts-v6` channel so it's as loud as the
 *     in-app alert; `data` is kept so a tap can route to the booking.
 *
 * `priority: 'high'` is what makes the wakeup fire on Doze devices.
 * Returns true on a successful send, false otherwise so callers can
 * decide whether to fall back to Expo push.
 *
 * @param {string} token - raw FCM device token from the partner-app
 * @param {object} data  - flat key→value map; values are auto-stringified
 *                         (FCM data payloads only accept strings).
 * @param {{title: string, body: string}|null} [notification] - when set,
 *                         send the hybrid (OS-rendered) form.
 */
const sendFcmDataMessage = async (token, data, notification = null) => {
  if (!firebase.isEnabled() || !token) return false;
  try {
    const stringData = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v == null) continue;
      stringData[k] = String(v);
    }

    const message = {
      token,
      data: stringData,
      android: {
        priority: 'high',
        /// TTL = the full 190-second dispatch window (DISPATCH_TOTAL_MS
        /// in dispatch/dispatcher.js). A phone in Doze can be unreachable for
        /// well over a minute; the old 60s TTL meant FCM dropped the offer
        /// before the device's next maintenance window, so the partner
        /// missed a job that was still live. Delivering for the whole
        /// window is the right bound — a late accept past expiry is
        /// rejected gracefully (`dispatch.claimed`).
        ttl: JOB_OFFER_PUSH_TTL_MS,
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'background',
        },
        payload: {
          aps: { contentAvailable: true },
        },
      },
    };

    if (notification) {
      message.notification = { title: notification.title, body: notification.body };
      message.android.notification = {
        channelId: JOB_ALERT_CHANNEL_ID,
        sound: 'job_alert.wav',
        visibility: 'public',
        /// Single shared tag → a new job-offer notification REPLACES the
        /// previous one instead of stacking. So the partner only ever
        /// sees ONE job-offer entry in the bar (mirrors the in-app
        /// full-screen alert, which uses a fixed notification id). Without
        /// this, every booking + every retry wave piled up a separate,
        /// never-clearing notification.
        tag: JOB_OFFER_NOTIFICATION_TAG,
      };
      /// Collapse in transit too — if several offer pushes queue while the
      /// device is in Doze, FCM keeps only the latest (same collapseKey),
      /// so the partner doesn't get a burst of stale offers on wake.
      message.android.collapseKey = JOB_OFFER_NOTIFICATION_TAG;
      /// iOS: a visible alert (not the silent background push the
      /// data-only branch uses), so a backgrounded/locked iPhone shows it.
      message.apns = {
        headers: { 'apns-priority': '10', 'apns-push-type': 'alert' },
        payload: {
          aps: {
            alert: { title: notification.title, body: notification.body },
            sound: 'default',
          },
        },
      };
    }

    await firebase.messaging().send(message);
    return true;
  } catch (err) {
    /// `registration-token-not-registered` is Firebase's authoritative
    /// "this device is GONE" — the app was uninstalled, notifications were
    /// hard-revoked, or the token rotated out. Surface it as a distinct
    /// return so the caller (which knows the partnerId) can force that
    /// partner off duty + drop the dead token, instead of letting them
    /// linger as "Available" for the full 4h sticky TTL.
    if (err.code === 'messaging/registration-token-not-registered') {
      logger.warn(`[push] FCM token unregistered (device gone) ...${token.slice(-8)}`);
      return 'token-dead';
    }
    logger.warn(`[push] FCM send failed for ...${token.slice(-8)}: ${err.message}`);
    return false;
  }
};

/**
 * Send job-offer push notifications to a list of partners.
 *
 * The dispatcher passes every eligible partner, including socket-
 * connected partners. A socket can look alive on the server while the
 * mobile OS has suspended the app, so socket-only delivery can miss the
 * real phone alert. Prefers a hybrid direct-FCM message when the partner
 * has an `fcmToken` — the OS renders it even on a frozen/killed device —
 * and falls back to the legacy Expo push when only `expoPushToken` is set.
 *
 * @param {object} prisma
 * @param {number[]} partnerIds  - EVERY eligible candidate, not just the
 *   ones without a socket: a mobile socket can read as "connected" on the
 *   server after Android has already suspended the app, so socket-only
 *   delivery looks successful while producing no alert on the phone.
 * @param {{ bookingId: number, serviceName: string, amount: number, dispatchWave?: number, address?: string }} jobInfo
 */
const sendJobOfferPushes = async (prisma, partnerIds, { bookingId, serviceName, amount, dispatchWave, address, byop, offerWindowSec }, distanceByPartner = {}) => {
  if (!partnerIds || partnerIds.length === 0) return;
  try {
    const partners = await prisma.partner.findMany({
      where: { id: { in: partnerIds } },
      select: { id: true, expoPushToken: true, fcmToken: true },
    });
    await Promise.all(
      partners.map(async (p) => {
        if (p.fcmToken) {
          const sent = await sendFcmDataMessage(
            p.fcmToken,
            /// `address` rides along so the in-app job card renders the
            /// service address instantly from the push stub instead of
            /// waiting ~3-5s on the refreshIncoming HTTP fetch.
            ///
            /// DATA-ONLY, deliberately no notification block: the OS used
            /// to render its own banner the instant the push arrived,
            /// BEFORE the app could pick its surface — so partners saw a
            /// banner flash AND the overlay card / full-screen alert for
            /// the same job. The app now owns the choice entirely: the
            /// Rapido-style overlay card (screen on + unlocked), or the
            /// notifee full-screen takeover (locked / no overlay grant),
            /// each with its own sound + vibration. Any state where the
            /// data handler can't run (force-stopped app) also blocks
            /// notification-payload rendering, so the hybrid form added
            /// no real reach — only the double alert.
            {
              type: 'job_request', bookingId, serviceName, amount, dispatchWave, address,
              /// Offer-card lifetime, decided server-side: 10s for BYOP
              /// (the customer is offered price bumps at 10s), 30s for
              /// scheduled / instant pay-now. The background surfaces
              /// render from this payload alone, so it has to ride along.
              byop, offerWindowSec,
              /// This partner's own distance to the job, when the dispatcher
              /// computed one — drives the "6 min (2.0 km)" line on the card.
              ...(Number.isFinite(Number(distanceByPartner[p.id]))
                ? { distanceKm: Number(distanceByPartner[p.id]).toFixed(2) }
                : {}),
            },
          );
          /// Device is GONE (uninstalled / token dead) — force this partner
          /// off duty so dispatch stops wasting a broadcast slot on them and
          /// they drop out of the admin "Available" list. Don't fall back to
          /// Expo (that token's dead too if the app's uninstalled).
          if (sent === 'token-dead') {
            void require('../tracking/tracking.service').forceOffDutyDeadDevice({
              partnerId: p.id,
              deadToken: p.fcmToken,
            });
            return;
          }
          /// Direct FCM is the reliable path — only fall back to Expo
          /// when this partner has no FCM token at all or the send
          /// itself failed (network glitch / stale token).
          if (sent) return;
        }
        if (p.expoPushToken) {
          await sendPush(p.expoPushToken, {
            title: 'New job request!',
            body: `${serviceName} · ₹${amount} near you`,
            data: {
              bookingId: String(bookingId),
              type: 'job_request',
              ...(dispatchWave != null ? { dispatchWave: String(dispatchWave) } : {}),
            },
          });
        }
      }),
    );
  } catch (err) {
    logger.warn(`[push] sendJobOfferPushes failed: ${err.message}`);
  }
};

/**
 * Push for an admin-ASSIGNED job (Manual Dispatch / booking-details
 * Assign). Distinct copy + `type: 'job_assigned'` from the offer push:
 * the job is already the partner's, so the app opens the booking on tap
 * (no Accept/Decline). Covers the closed/backgrounded-app case; the
 * `job.assigned` socket event handles the open-app 5s ring.
 *
 * Same FCM-preferred / Expo-fallback strategy as the offer push.
 *
 * @param {object} prisma
 * @param {number} partnerId
 * @param {{ bookingId: number, serviceName: string, amount: number }} jobInfo
 */
const sendJobAssignedPush = async (prisma, partnerId, { bookingId, serviceName, amount }) => {
  if (partnerId == null) return;
  try {
    const partner = await prisma.partner.findUnique({
      where: { id: Number(partnerId) },
      select: { expoPushToken: true, fcmToken: true },
    });
    if (!partner) return;
    if (partner.fcmToken) {
      const sent = await sendFcmDataMessage(
        partner.fcmToken,
        { type: 'job_assigned', bookingId, serviceName, amount },
        { title: 'New job assigned', body: `${serviceName} · ₹${amount} — tap to view` },
      );
      /// Device gone — force off duty + drop the dead token. Still attempt
      /// the Expo fallback below in case that channel somehow survives.
      if (sent === 'token-dead') {
        void require('../tracking/tracking.service').forceOffDutyDeadDevice({
          partnerId: Number(partnerId),
          deadToken: partner.fcmToken,
        });
      } else if (sent) {
        return;
      }
    }
    if (partner.expoPushToken) {
      await sendPush(partner.expoPushToken, {
        title: 'New job assigned',
        body: `${serviceName} · ₹${amount} — tap to view`,
        data: { bookingId: String(bookingId), type: 'job_assigned' },
      });
    }
  } catch (err) {
    logger.warn(`[push] sendJobAssignedPush failed: ${err.message}`);
  }
};

/**
 * Push a booking-lifecycle alert to a CUSTOMER's device.
 *
 * Counterpart to the partner helpers above. Booking events previously
 * reached the customer app over the socket ONLY, which works while the app
 * is foregrounded and connected — but a backgrounded/killed app has no
 * socket, so events like "your partner has arrived" were never seen. This
 * sends a real system notification so it lands regardless of app state.
 *
 * FCM first (survives a swiped-away app), Expo as the fallback for older
 * installs that only registered an Expo token. The `notification` block is
 * what makes Android render it while the app is backgrounded; `data`
 * carries the bookingId so tapping it can deep-link.
 *
 * Best-effort: never throws, so a push failure can't break the booking
 * flow that triggered it.
 *
 * @param {object} prisma
 * @param {number} customerId
 * @param {{ title: string, body: string, type: string, bookingId: number|string }} msg
 */
const sendCustomerPush = async (prisma, customerId, { title, body, type, bookingId }) => {
  if (customerId == null) return;
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: Number(customerId) },
      select: { expoPushToken: true, fcmToken: true },
    });
    if (!customer) return;

    if (customer.fcmToken) {
      const sent = await sendFcmDataMessage(
        customer.fcmToken,
        { type, bookingId: String(bookingId) },
        { title, body },
      );
      /// Anything other than a dead token means it went out — don't
      /// double-send over Expo.
      if (sent && sent !== 'token-dead') return;
    }

    if (customer.expoPushToken) {
      await sendPush(customer.expoPushToken, {
        title,
        body,
        data: { bookingId: String(bookingId), type },
      });
    }
  } catch (err) {
    logger.warn(`[push] sendCustomerPush(${type}) failed: ${err.message}`);
  }
};

/**
 * Clear the job-offer notification from a set of partners' notification
 * bars — sent when the booking is TAKEN by someone else or its dispatch
 * window EXPIRES, so a stale "New job" alert doesn't linger. A data-only
 * FCM message (`type: 'job_clear'`) wakes the app, which cancels the
 * notification by its shared tag. Best-effort + fire-and-forget; a
 * failed clear just means the notification ages out on its own TTL.
 *
 * @param {object} prisma
 * @param {number[]} partnerIds  - the audience that was offered the job
 * @param {number} bookingId
 */
const clearJobOfferPush = async (prisma, partnerIds, bookingId) => {
  if (!Array.isArray(partnerIds) || partnerIds.length === 0) return;
  try {
    const partners = await prisma.partner.findMany({
      where: { id: { in: partnerIds.map(Number) } },
      select: { id: true, fcmToken: true },
    });
    await Promise.allSettled(
      partners.map((p) => {
        if (!p.fcmToken) return null;
        /// Data-only (no notification block) so it silently wakes the app
        /// to dismiss — it must NOT itself render a notification.
        return sendFcmDataMessage(p.fcmToken, {
          type: 'job_clear',
          bookingId: String(bookingId),
        });
      }),
    );
  } catch (err) {
    logger.warn(`[push] clearJobOfferPush failed: ${err.message}`);
  }
};

module.exports = {
  sendPush,
  sendFcmDataMessage,
  sendJobOfferPushes,
  sendJobAssignedPush,
  sendCustomerPush,
  clearJobOfferPush,
  JOB_OFFER_NOTIFICATION_TAG,
};
