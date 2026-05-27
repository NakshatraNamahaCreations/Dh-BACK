const logger = require('../../config/logger');
const firebase = require('../../config/firebase');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/// MUST match `CHANNEL_ID` in partner-app/src/services/notifications.ts —
/// the MAX-importance channel (ringtone-length custom sound, strong
/// vibration, bypassDnd, public lock-screen). When an FCM message carries
/// a notification block the OS renders it on this channel, so a
/// system-rendered alert is exactly as loud as the in-app one.
const JOB_ALERT_CHANNEL_ID = 'job-alerts-v6';

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
        /// 180s = the full dispatch window (3 waves × 60s — see
        /// DISPATCH_TOTAL_MS in dispatch/dispatcher.js). A device in a Doze
        /// maintenance gap can be unreachable for more than a minute; the
        /// old 60s TTL meant FCM/Expo discarded the offer before the phone
        /// next woke, so the partner never saw a job that was still live.
        /// Matching the dispatch window means the offer is delivered for as
        /// long as it could still be accepted, and no longer (a stale accept
        /// past expiry is rejected gracefully via `dispatch.claimed`).
        ttl: 180,
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
        /// TTL = the full 3-minute dispatch window (DISPATCH_TOTAL_MS in
        /// dispatch/dispatcher.js). A phone in Doze can be unreachable for
        /// well over a minute; the old 60s TTL meant FCM dropped the offer
        /// before the device's next maintenance window, so the partner
        /// missed a job that was still live. Delivering for the whole
        /// window is the right bound — a late accept past expiry is
        /// rejected gracefully (`dispatch.claimed`).
        ttl: 180_000,
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
      };
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
    /// Common reasons: invalid / unregistered token (clean these up
    /// in a follow-up — Firebase returns `registration-token-not-registered`).
    logger.warn(`[push] FCM send failed for ...${token.slice(-8)}: ${err.message}`);
    return false;
  }
};

/**
 * Send job-offer push notifications to a list of partners.
 *
 * Callers pass ONLY partners without a live socket (the dispatcher
 * delivers the in-app offer to connected ones). Prefers a hybrid
 * direct-FCM message when the partner has an `fcmToken` — the OS renders
 * it even on a frozen/killed device — and falls back to the legacy Expo
 * push when only `expoPushToken` is set.
 *
 * @param {object} prisma
 * @param {number[]} partnerIds  - offline partners only (see dispatcher)
 * @param {{ bookingId: number, serviceName: string, amount: number }} jobInfo
 */
const sendJobOfferPushes = async (prisma, partnerIds, { bookingId, serviceName, amount }) => {
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
            { type: 'job_request', bookingId, serviceName, amount },
            /// Hybrid form — callers pass only OFFLINE partners here (the
            /// dispatcher already sent connected ones the in-app offer),
            /// so the OS-rendered notification can reach a frozen/killed
            /// device without double-alerting anyone.
            { title: 'New job request!', body: `${serviceName} · ₹${amount} near you` },
          );
          /// Direct FCM is the reliable path — only fall back to Expo
          /// when this partner has no FCM token at all or the send
          /// itself failed (network glitch / stale token).
          if (sent) return;
        }
        if (p.expoPushToken) {
          await sendPush(p.expoPushToken, {
            title: 'New job request!',
            body: `${serviceName} · ₹${amount} near you`,
            data: { bookingId: String(bookingId), type: 'job_request' },
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
      if (sent) return;
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

module.exports = { sendPush, sendFcmDataMessage, sendJobOfferPushes, sendJobAssignedPush };
