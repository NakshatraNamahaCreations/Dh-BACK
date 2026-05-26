const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
const logger = require('./logger');

/**
 * Firebase Admin SDK bootstrapping.
 *
 * Used to send direct FCM data messages to partner devices — far more
 * reliable than going through Expo's relay on aggressive OEMs (Vivo,
 * Oppo, Xiaomi) which throttle or drop relayed pushes when the app is
 * swiped away. A direct data message wakes the device's JS background
 * handler, which fires the notifee full-screen alert.
 *
 * Credentials are loaded from a service-account JSON file. Resolution
 * order (first match wins):
 *
 *   1. `FIREBASE_SERVICE_ACCOUNT` env var — path to the JSON file.
 *   2. `FIREBASE_SERVICE_ACCOUNT_JSON` env var — the JSON contents
 *      themselves (useful for hosted environments with no filesystem).
 *   3. `backend/firebase-service-account.json` (gitignored by default).
 *
 * If none of the above is present, `isEnabled()` returns false and the
 * push layer transparently falls back to the legacy Expo push path —
 * the backend keeps working, you just don't get the killed-app wakeup
 * until the service account is wired in.
 */

let app = null;
let initialized = false;

const resolveCredential = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      return admin.credential.cert(parsed);
    } catch (err) {
      logger.warn(`[firebase] FIREBASE_SERVICE_ACCOUNT_JSON parse failed: ${err.message}`);
    }
  }
  const candidates = [
    process.env.FIREBASE_SERVICE_ACCOUNT,
    path.join(__dirname, '..', '..', 'firebase-service-account.json'),
  ].filter(Boolean);
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        return admin.credential.cert(require(filePath));
      }
    } catch (err) {
      logger.warn(`[firebase] credential load failed at ${filePath}: ${err.message}`);
    }
  }
  return null;
};

const init = () => {
  if (initialized) return app;
  initialized = true;
  const credential = resolveCredential();
  if (!credential) {
    logger.warn(
      '[firebase] No service-account credentials found. ' +
        'Direct-FCM push disabled; falling back to Expo push. ' +
        'Drop a service-account JSON at backend/firebase-service-account.json ' +
        '(or set FIREBASE_SERVICE_ACCOUNT / FIREBASE_SERVICE_ACCOUNT_JSON) to enable.',
    );
    return null;
  }
  try {
    app = admin.initializeApp({ credential });
    logger.info('[firebase] Admin SDK initialized — direct-FCM push enabled');
    return app;
  } catch (err) {
    logger.warn(`[firebase] initializeApp failed: ${err.message}`);
    return null;
  }
};

const isEnabled = () => init() != null;

const messaging = () => {
  const a = init();
  return a ? admin.messaging() : null;
};

module.exports = { admin, init, isEnabled, messaging };
