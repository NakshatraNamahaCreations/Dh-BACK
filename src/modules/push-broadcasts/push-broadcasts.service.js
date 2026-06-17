const prisma = require('../../config/prisma');
const logger = require('../../config/logger');
const firebase = require('../../config/firebase');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100; // Expo accepts up to 100 per request
const FCM_BATCH_SIZE = 500; // firebase-admin multicast cap per request

const sendBatch = async (messages) => {
  if (!messages.length) return;
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn(`[push-broadcast] Expo API ${res.status}: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    logger.warn(`[push-broadcast] batch failed: ${err.message}`);
  }
};

/// Direct-FCM multicast for recipients whose device registered a RAW FCM
/// token (Android). This bypasses Expo's relay — which is throttled/dropped
/// on aggressive OEMs (Vivo/Oppo/Xiaomi) when the app is swiped away — and
/// renders an OS notification that shows even when the app is killed. Reuses
/// the backend's already-configured firebase-admin (same as partner pushes);
/// no-ops gracefully when Firebase isn't configured.
const sendFcmBroadcast = async (tokens, { title, body, imageUrl }) => {
  const messaging = firebase.messaging();
  if (!messaging || tokens.length === 0) return;
  for (let i = 0; i < tokens.length; i += FCM_BATCH_SIZE) {
    const chunk = tokens.slice(i, i + FCM_BATCH_SIZE);
    try {
      await messaging.sendEachForMulticast({
        tokens: chunk,
        notification: { title, body, ...(imageUrl ? { imageUrl } : {}) },
        android: {
          priority: 'high',
          notification: {
            channelId: 'general',
            ...(imageUrl ? { imageUrl } : {}),
          },
        },
        apns: {
          payload: { aps: { sound: 'default' } },
          ...(imageUrl ? { fcmOptions: { imageUrl } } : {}),
        },
      });
    } catch (err) {
      logger.warn(`[push-broadcast] FCM multicast failed: ${err.message}`);
    }
  }
};

/// Collect push tokens for the audience. For EACH device we prefer its raw
/// FCM token (direct FCM) over its Expo token, so a device that has both
/// gets exactly ONE notification — via the more reliable channel.
const collectTokens = async (audience) => {
  const expoTokens = [];
  const fcmTokens = [];
  const pick = (rows) => {
    rows.forEach((r) => {
      if (r.fcmToken) fcmTokens.push(r.fcmToken);
      else if (r.expoPushToken?.startsWith('ExponentPushToken[')) expoTokens.push(r.expoPushToken);
    });
  };

  const where = {
    isActive: true,
    OR: [{ expoPushToken: { not: null } }, { fcmToken: { not: null } }],
  };
  const select = { expoPushToken: true, fcmToken: true };

  if (audience === 'partners' || audience === 'all') {
    pick(await prisma.partner.findMany({ where, select }));
  }
  if (audience === 'customers' || audience === 'all') {
    pick(await prisma.customer.findMany({ where, select }));
  }

  return { expoTokens, fcmTokens };
};

exports.send = async (adminId, { title, body, imageUrl, audience }) => {
  const { expoTokens, fcmTokens } = await collectTokens(audience);

  // Legacy Expo relay — for devices that only have an Expo token (iOS, or
  // older Android builds before the raw-FCM token registration).
  const messages = expoTokens.map((token) => ({
    to: token,
    title,
    body,
    ...(imageUrl ? { image: imageUrl } : {}),
    sound: 'default',
    priority: 'high',
    channelId: 'general',
  }));
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await sendBatch(messages.slice(i, i + BATCH_SIZE));
  }

  // Direct FCM — for devices with a raw FCM token (reliable on OEMs).
  await sendFcmBroadcast(fcmTokens, { title, body, imageUrl });

  const record = await prisma.pushBroadcast.create({
    data: {
      title,
      body,
      imageUrl: imageUrl ?? null,
      audience,
      sentBy: adminId,
      sentCount: expoTokens.length + fcmTokens.length,
    },
  });

  return record;
};

/// Remove a broadcast from the history log. This only deletes the record
/// of a past send — it does not (and cannot) recall a notification that was
/// already delivered to devices.
exports.remove = async (id) => {
  await prisma.pushBroadcast.delete({ where: { id } });
  return { id };
};

exports.list = async ({ page = 1, pageSize = 20 } = {}) => {
  const skip = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    prisma.pushBroadcast.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.pushBroadcast.count(),
  ]);
  return { data: rows, meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
};
