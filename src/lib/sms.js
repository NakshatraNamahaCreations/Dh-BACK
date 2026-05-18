/**
 * Bulk SMS sender — wraps the yourbulksms.com HTTP API. Used by the OTP
 * flow for both customer and partner authentication. Env vars (set in
 * backend/.env):
 *
 *   SMS_AUTHKEY            (required for prod)
 *   SMS_SENDER_ID          (default "DHOOND")
 *   SMS_DLT_TEMPLATE_ID    (required for prod — DLT compliance in India)
 *   SMS_API_URL            (default control.yourbulksms.com)
 *   SMS_ROUTE              (default 2)
 *   SMS_COUNTRY            (default 0)
 *
 * If `SMS_AUTHKEY` is unset, `sendSms` is a no-op that returns true —
 * upstream flows fall back to printing the OTP to the server console
 * for dev-time self-serve verification.
 */
const env = require('../config/env');
const logger = require('../config/logger');

const isConfigured = () => Boolean(env.SMS_AUTHKEY);

/// Send a generic SMS. Swallows errors and returns false so the caller
/// can decide whether the failure is critical (e.g. a real OTP send in
/// production should hard-fail; an internal notification might be
/// best-effort). Caller is the policy owner.
const sendSms = async ({ phone, message }) => {
  if (!isConfigured()) {
    logger.warn(
      `[SMS] SMS_AUTHKEY not set — would have sent to +91${phone}: "${message}"`,
    );
    return false;
  }

  /// Strip any +91 / spaces / dashes the caller might have passed in —
  /// the bulksms API expects a 10-digit number prefixed with "91".
  const normalised = String(phone).replace(/\D/g, '').slice(-10);
  if (normalised.length !== 10) {
    logger.error(`[SMS] Invalid phone "${phone}" — must be 10 digits`);
    return false;
  }

  /// Build the query string manually with `encodeURIComponent` so spaces
  /// become `%20` (RFC 3986). Using `URLSearchParams` would encode them
  /// as `+` which is the form-encoded variant — yourbulksms.com is PHP-
  /// based and treats `+` as a literal plus character in the message
  /// body, breaking the DLT-template character-for-character match and
  /// causing the carrier to drop the SMS silently.
  const enc = encodeURIComponent;
  const queryParts = [
    `authkey=${enc(env.SMS_AUTHKEY)}`,
    `mobiles=91${normalised}`,
    `message=${enc(message)}`,
    `sender=${enc(env.SMS_SENDER_ID)}`,
    `route=${env.SMS_ROUTE}`,
    `country=${env.SMS_COUNTRY}`,
  ];
  if (env.SMS_DLT_TEMPLATE_ID) {
    queryParts.push(`DLT_TE_ID=${enc(env.SMS_DLT_TEMPLATE_ID)}`);
  }
  const url = `${env.SMS_API_URL}?${queryParts.join('&')}`;

  try {
    /// Node 18+ has global fetch — no extra dep needed.
    const res = await fetch(url, { method: 'GET' });
    const body = await res.text();
    if (!res.ok) {
      logger.error(`[SMS] HTTP ${res.status} sending to +91${normalised}: ${body}`);
      return false;
    }
    /// Some bulksms providers return success-shaped 200s with an error
    /// message in the body (e.g. "AUTHKEY_INVALID"). Surface those so
    /// they don't look like silent successes in the logs.
    if (/error|invalid|fail/i.test(body)) {
      logger.error(`[SMS] Provider returned error for +91${normalised}: ${body}`);
      return false;
    }
    logger.info(`[SMS] Sent to +91${normalised}: ${body.trim()}`);
    return true;
  } catch (err) {
    logger.error(
      `[SMS] Network error sending to +91${normalised}: ${err.message}`,
    );
    return false;
  }
};

/// Convenience wrapper for OTP sends. Uses the exact DLT-approved
/// template wording — keep this in lock-step with the template
/// registered against SMS_DLT_TEMPLATE_ID, otherwise the carrier will
/// reject the message.
const sendOtpSms = (phone, code) =>
  sendSms({
    phone,
    message: `${code} is your One Time Password (OTP) for login/signup at DHOOND. This OTP will only be valid for 10 minutes. Do not share with anyone`,
  });

module.exports = { sendSms, sendOtpSms, isConfigured };
