const bcrypt = require('bcryptjs');
const prisma = require('../../config/prisma');
const env = require('../../config/env');
const logger = require('../../config/logger');
const ApiError = require('../../utils/ApiError');
const sms = require('../../lib/sms');

const OTP_TTL_MIN = Number(env.OTP_EXPIRY_MINUTES) || 5;
const OTP_RESEND_SECONDS = Number(env.OTP_RESEND_SECONDS) || 60;
const OTP_MAX_ATTEMPTS = 5;

/// 4-digit OTP. Range 1000–9999 keeps the leading digit non-zero so
/// the SMS doesn't show "0123" which some carriers strip the leading
/// zero from in transit.
const generateCode = () => String(Math.floor(1000 + Math.random() * 9000));

/// Delivers the OTP via yourbulksms.com when SMS_AUTHKEY is set; falls
/// back to console-logging in dev/unconfigured setups so onboarding
/// engineers and QA can self-serve. In production the SMS provider is
/// the only path — `requestOtp` enforces that below by rejecting if the
/// send fails when NODE_ENV === 'production'.
const sendSms = async (phone, code) => {
  if (sms.isConfigured()) {
    return sms.sendOtpSms(phone, code);
  }
  if (env.NODE_ENV !== 'production') {
    logger.info(`[DEV OTP] phone=${phone} code=${code}`);
    return true;
  }
  return false;
};

const requestOtp = async ({ phone, userType }) => {
  const recent = await prisma.otp.findFirst({
    where: { phone, userType, consumed: false },
    orderBy: { createdAt: 'desc' },
  });

  if (recent) {
    const elapsed = (Date.now() - recent.createdAt.getTime()) / 1000;
    if (elapsed < OTP_RESEND_SECONDS) {
      throw ApiError.badRequest(
        `Please wait ${Math.ceil(OTP_RESEND_SECONDS - elapsed)}s before requesting a new OTP`
      );
    }
    await prisma.otp.updateMany({
      where: { phone, userType, consumed: false },
      data: { consumed: true },
    });
  }

  const code = generateCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000);

  await prisma.otp.create({
    data: { phone, userType, codeHash, expiresAt },
  });

  /// Send the SMS *before* we tell the client "OTP sent". In production
  /// a failed send is a hard error — better to surface "couldn't send
  /// OTP" than to silently issue an unsent code that the user will then
  /// type forever. In dev we log the code locally so the flow continues.
  const sent = await sendSms(phone, code);
  if (!sent && env.NODE_ENV === 'production') {
    /// Mark the issued OTP consumed so a retry mints a fresh one rather
    /// than colliding with the resend cooldown on the unsent record.
    await prisma.otp.updateMany({
      where: { phone, userType, consumed: false },
      data: { consumed: true },
    });
    throw ApiError.internal("Couldn't send OTP — please try again in a moment.");
  }

  // In non-production builds we leak the plain code back to the client so
  // developers can self-serve OTP entry without an SMS provider wired up.
  // The check on env.NODE_ENV is the hard gate — never include devCode in
  // production responses.
  const payload = { expiresInSeconds: OTP_TTL_MIN * 60 };
  if (env.NODE_ENV !== 'production') {
    payload.devCode = code;
  }
  return payload;
};

const verifyOtp = async ({ phone, userType, code }) => {
  const otp = await prisma.otp.findFirst({
    where: { phone, userType, consumed: false },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp) throw ApiError.badRequest('OTP not requested or already used');
  if (otp.expiresAt < new Date()) {
    await prisma.otp.update({ where: { id: otp.id }, data: { consumed: true } });
    throw ApiError.badRequest('OTP has expired');
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await prisma.otp.update({ where: { id: otp.id }, data: { consumed: true } });
    throw ApiError.badRequest('Too many invalid attempts. Please request a new OTP');
  }

  const ok = await bcrypt.compare(code, otp.codeHash);

  if (!ok) {
    await prisma.otp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    throw ApiError.badRequest('Invalid OTP');
  }

  await prisma.otp.update({ where: { id: otp.id }, data: { consumed: true } });
};

module.exports = { requestOtp, verifyOtp };
