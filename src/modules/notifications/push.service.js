const logger = require('../../config/logger');

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
        /// Bumped from v3 → v4 alongside the client. Channel IDs are
        /// immutable on Android, so when we bump the client to fix
        /// importance-lock, the backend has to follow or pushes land
        /// in the old (silent) channel and never alert the partner.
        channelId: 'job-alerts-v5',
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
 * Send job-offer push notifications to a list of partners.
 * Looks up each partner's expoPushToken and fires in parallel.
 * Ignores partners with no token stored.
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
      select: { id: true, expoPushToken: true },
    });
    await Promise.all(
      partners
        .filter((p) => p.expoPushToken)
        .map((p) =>
          sendPush(p.expoPushToken, {
            title: 'New job request!',
            body: `${serviceName} · ₹${amount} near you`,
            data: { bookingId: String(bookingId), type: 'job_request' },
          }),
        ),
    );
  } catch (err) {
    logger.warn(`[push] sendJobOfferPushes failed: ${err.message}`);
  }
};

module.exports = { sendPush, sendJobOfferPushes };
