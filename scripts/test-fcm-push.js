/**
 * Manual test: fire a hybrid job-alert FCM push straight to one partner's
 * device, bypassing the whole booking/dispatch flow. Use it to verify the
 * "alert shows even when the app is killed/locked" fix in isolation.
 *
 * How to use:
 *   1. On the test phone, open the partner app and go ON DUTY once (with
 *      network) so its FCM token is registered with the backend.
 *   2. FORCE-STOP / swipe the app away and lock the phone.
 *   3. From backend/, run:  node scripts/test-fcm-push.js <partnerId|phone>
 *   4. A loud notification should light up the locked screen within a few
 *      seconds. If it does, the OS-rendered (hybrid) delivery works.
 *
 * This calls the real push.service.sendFcmDataMessage with the same hybrid
 * payload the dispatcher now uses, so it tests the actual changed code.
 */
require('dotenv').config();

const prisma = require('../src/config/prisma');
const firebase = require('../src/config/firebase');
const { sendFcmDataMessage, sendPush } = require('../src/modules/notifications/push.service');

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: node scripts/test-fcm-push.js <partnerId | phone>');
    process.exit(1);
  }

  if (!firebase.isEnabled()) {
    console.error(
      'Firebase Admin is NOT enabled (no valid FIREBASE_SERVICE_ACCOUNT_JSON / ' +
        'service-account file). Direct-FCM is what this test exercises — aborting.',
    );
    process.exit(1);
  }

  /// Short all-digit input = partner id; anything else = phone (substring
  /// match so you don't have to type the +91 / spacing exactly).
  const where = /^\d{1,6}$/.test(arg) ? { id: Number(arg) } : { phone: { contains: arg } };
  const partner = await prisma.partner.findFirst({
    where,
    select: { id: true, name: true, phone: true, fcmToken: true, expoPushToken: true },
  });

  if (!partner) {
    console.error(`No partner found for "${arg}".`);
    process.exit(1);
  }

  console.log(`Partner #${partner.id} — ${partner.name} (${partner.phone})`);
  console.log(`  fcmToken      : ${partner.fcmToken ? '…' + partner.fcmToken.slice(-12) : '(none)'}`);
  console.log(`  expoPushToken : ${partner.expoPushToken ? 'present' : '(none)'}`);

  const job = { type: 'job_request', bookingId: 999999, serviceName: 'TEST · AC Service', amount: 499 };
  const copy = { title: 'New job request!', body: 'TEST · AC Service · ₹499 near you' };

  if (partner.fcmToken) {
    const ok = await sendFcmDataMessage(partner.fcmToken, job, copy);
    console.log(ok
      ? '✔ Firebase accepted the hybrid push. Check the killed/locked phone now.'
      : '✗ FCM send failed (see the [push] warning above — usually a stale/invalid token).');
  } else if (partner.expoPushToken) {
    console.warn('No FCM token — testing the Expo fallback path instead.');
    await sendPush(partner.expoPushToken, { title: copy.title, body: copy.body, data: { bookingId: '999999', type: 'job_request' } });
    console.log('✔ Expo push dispatched (fallback path). Check the phone.');
  } else {
    console.error('Partner has neither an FCM nor an Expo token. Go on duty in the app once (with network) to register one.');
    process.exit(1);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
