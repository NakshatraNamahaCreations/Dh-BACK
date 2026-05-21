const prisma = require('../../config/prisma');
const logger = require('../../config/logger');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const BATCH_SIZE = 100; // Expo accepts up to 100 per request

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

const collectTokens = async (audience) => {
  const tokens = [];

  if (audience === 'partners' || audience === 'all') {
    const partners = await prisma.partner.findMany({
      where: { isActive: true, expoPushToken: { not: null } },
      select: { expoPushToken: true },
    });
    partners.forEach((p) => {
      if (p.expoPushToken?.startsWith('ExponentPushToken[')) tokens.push(p.expoPushToken);
    });
  }

  if (audience === 'customers' || audience === 'all') {
    const customers = await prisma.customer.findMany({
      where: { isActive: true, expoPushToken: { not: null } },
      select: { expoPushToken: true },
    });
    customers.forEach((c) => {
      if (c.expoPushToken?.startsWith('ExponentPushToken[')) tokens.push(c.expoPushToken);
    });
  }

  return tokens;
};

exports.send = async (adminId, { title, body, imageUrl, audience }) => {
  const tokens = await collectTokens(audience);

  const messages = tokens.map((token) => ({
    to: token,
    title,
    body,
    ...(imageUrl ? { image: imageUrl } : {}),
    sound: 'default',
    priority: 'high',
    channelId: 'general',
  }));

  // Send in parallel batches of 100
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    await sendBatch(messages.slice(i, i + BATCH_SIZE));
  }

  const record = await prisma.pushBroadcast.create({
    data: {
      title,
      body,
      imageUrl: imageUrl ?? null,
      audience,
      sentBy: adminId,
      sentCount: tokens.length,
    },
  });

  return record;
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
