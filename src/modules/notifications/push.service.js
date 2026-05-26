const logger = require('../../config/logger');
const firebase = require('../../config/firebase');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

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
        ttl: 60,
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
 * Send a direct FCM data-only message to a single device.
 *
 * Why data-only (no `notification` block): a data message wakes the
 * partner-app's JS background message handler even when the app has
 * been swiped away. The handler then fires the notifee full-screen
 * alert — bypassing the OEM throttling that drops Expo-relay pushes on
 * Vivo / Oppo / Xiaomi. `priority: 'high'` is what makes the wakeup
 * actually fire on Doze devices.
 *
 * Returns true on a successful send, false otherwise so callers can
 * decide whether to fall back to Expo push.
 *
 * @param {string} token - raw FCM device token from the partner-app
 * @param {object} data  - flat key→value map; values are auto-stringified
 *                         (FCM data payloads only accept strings).
 */
const sendFcmDataMessage = async (token, data) => {
  if (!firebase.isEnabled() || !token) return false;
  try {
    const stringData = {};
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v == null) continue;
      stringData[k] = String(v);
    }
    await firebase.messaging().send({
      token,
      data: stringData,
      android: {
        priority: 'high',
        /// TTL of 60s — if the device hasn't been reachable for a
        /// minute we don't want a stale offer landing on it.
        ttl: 60_000,
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
    });
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
 * Prefers a direct-FCM data message when the partner has an `fcmToken`
 * (lets the app's background handler fire the notifee full-screen
 * alert from a killed state), and falls back to the legacy Expo push
 * when only `expoPushToken` is set.
 *
 * @param {object} prisma
 * @param {number[]} partnerIds
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
          const sent = await sendFcmDataMessage(p.fcmToken, {
            type: 'job_request',
            bookingId,
            serviceName,
            amount,
          });
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
      const sent = await sendFcmDataMessage(partner.fcmToken, {
        type: 'job_assigned',
        bookingId,
        serviceName,
        amount,
      });
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
