/**
 * QuickeKYC integration — third-party Aadhaar / PAN / Driving-License
 * verification for partner onboarding.
 *
 * Three endpoints wrapped:
 *
 *   1. POST /api/v1/aadhaar-v2/generate-otp
 *      Partner enters their 12-digit Aadhaar; QuickeKYC sends an OTP
 *      to the linked mobile and returns a `request_id` we hand back
 *      to the client to use in step 2.
 *
 *   2. POST /api/v1/aadhaar-v2/submit-otp
 *      Partner enters the OTP; QuickeKYC returns the full Aadhaar
 *      profile (name, DOB, gender, address). We snapshot the verified
 *      number + name + DOB onto PartnerDocument and flip kycStatus to
 *      'verified'.
 *
 *   3. POST /api/v1/pan/pan_advance
 *      Single-shot PAN verification. Returns holder name + DOB; we
 *      snapshot and flip a PAN-specific status on the document row.
 *
 *   4. POST /api/v1/driving-license/driving-license
 *      Single-shot DL verification. Requires DL number + DOB; returns
 *      holder name, validity, vehicle classes.
 *
 * Auth: QuickeKYC takes the API token in the request BODY as `key`,
 * not a header. The token is server-side only — partners and the
 * partner-app never see it.
 *
 * Storage strategy: we store only the minimal fields we already had
 * on PartnerDocument (numbers + kycStatus / kycVerifiedAt / kycNote).
 * The verified Aadhaar address etc. is logged in kycNote as JSON so
 * admin can see the raw verification payload without us adding
 * dedicated columns for every QuickeKYC field.
 */
const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const env = require('../../config/env');
const logger = require('../../config/logger');

const PROVIDER = 'quickekyc';

const ensureConfigured = () => {
  if (!env.QUICKEKYC_API_TOKEN) {
    throw new ApiError(
      503,
      'KYC verification is not configured. Set QUICKEKYC_API_TOKEN in the backend .env.',
    );
  }
};

/// Once a partner verifies an Aadhaar / PAN / DL number, no other
/// partner can lay claim to the same number. We can't enforce this
/// at the DB level via @unique without a migration that would
/// reject legacy rows; instead we check at verify-time. Only rows
/// where the *VerifiedAt timestamp is set count — an unverified
/// duplicate (someone typed in a number but never finished OTP)
/// shouldn't lock the real owner out.
///
/// `field` is one of 'aadharNumber' | 'panNumber' | 'dlNumber'.
/// `verifiedField` is the matching timestamp column.
const ensureNumberAvailable = async ({ partnerId, field, verifiedField, value, label }) => {
  const existing = await prisma.partnerDocument.findFirst({
    where: {
      [field]: value,
      [verifiedField]: { not: null },
      partnerId: { not: Number(partnerId) },
    },
    select: { partnerId: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      `This ${label} is already verified on another partner account. ` +
        `Contact support if you believe this is a mistake.`,
    );
  }
};

/// Thin POST helper. QuickeKYC accepts and returns JSON; the API
/// token goes in the body as `key`, not a header. We always inject
/// it so callers never need to think about credentials.
const post = async (path, body) => {
  const url = `${env.QUICKEKYC_BASE_URL.replace(/\/$/, '')}${path}`;
  const payload = { key: env.QUICKEKYC_API_TOKEN, ...body };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    logger.warn(`QuickeKYC network error on ${path}: ${err.message}`);
    throw new ApiError(502, 'Verification service is unreachable. Try again in a moment.');
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(502, 'Verification service returned an invalid response.');
  }

  /// QuickeKYC encodes per-field validation failures with status_code
  /// 422 inside a 200 HTTP response or as a non-2xx. Normalise both
  /// so the caller can branch on `data.status === 'success'`.
  return { httpStatus: res.status, body: data };
};

/// Step 1 of Aadhaar verification — send the OTP to the linked
/// mobile. Returns the `request_id` the client passes back into
/// submitAadhaarOtp.
exports.generateAadhaarOtp = async ({ partnerId, aadhaarNumber }) => {
  ensureConfigured();
  const digits = String(aadhaarNumber).replace(/\D/g, '');
  if (digits.length !== 12) {
    throw ApiError.badRequest('Aadhaar number must be 12 digits.');
  }

  const { body } = await post('/api/v1/aadhaar-v2/generate-otp', { id_number: digits });
  if (body?.status !== 'success' || !body?.request_id) {
    throw ApiError.badRequest(body?.message || 'Could not send Aadhaar OTP. Check the number.');
  }

  /// Stash the in-flight Aadhaar number + photo against the
  /// request_id on the partner row so step 2 can verify the OTP
  /// came from the same intent. The card photo (`aadharImageUrl`)
  /// is saved here on the generate step — submit-otp overwrites
  /// `selfieUrl` with the UIDAI face crop separately, but the
  /// partner-supplied card scan stays on `aadharImageUrl`.
  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      aadharNumber: digits,
      kycProvider: PROVIDER,
      kycStatus: 'pending',
    },
    update: {
      aadharNumber: digits,
      kycProvider: PROVIDER,
      kycStatus: 'pending',
    },
  });

  return {
    requestId: String(body.request_id),
    /// QuickeKYC's "valid_aadhaar" / "if_number" flags surfaced so
    /// the partner-app can show "OTP sent to xxx" reassurance.
    otpSent: Boolean(body.data?.otp_sent),
  };
};

/// Normalise the `profile_image` field QuickeKYC returns. Their docs
/// describe it as the Aadhaar holder's photo, but the wire format
/// varies between integrations:
///   - http(s) URL                → use as-is
///   - data URI ("data:image/…")  → use as-is
///   - raw base64                 → wrap with the standard data URI
///                                  prefix so RN Image renders it
///   - empty string / null        → return null (drop write)
const normaliseProfileImage = (raw) => {
  if (!raw || typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith('http://') || v.startsWith('https://')) return v;
  if (v.startsWith('data:')) return v;
  /// Looks like raw base64. JPEG is QuickeKYC's documented format;
  /// even if it were PNG the platform decoder sniffs bytes and
  /// ignores the MIME hint, so this hint is safe.
  return `data:image/jpeg;base64,${v}`;
};

/// Step 2 of Aadhaar — submit the OTP. On success we receive the
/// full profile and snapshot the key fields onto PartnerDocument +
/// flip kycStatus to verified. The holder's photo (`profile_image`)
/// is saved straight into `aadharImageUrl` so the partner doesn't
/// have to upload an Aadhaar card scan separately.
exports.submitAadhaarOtp = async ({ partnerId, requestId, otp }) => {
  ensureConfigured();
  if (!requestId || !otp) {
    throw ApiError.badRequest('Both requestId and otp are required.');
  }

  const { body } = await post('/api/v1/aadhaar-v2/submit-otp', {
    request_id: String(requestId),
    otp: String(otp),
  });
  if (body?.status !== 'success' || !body?.data) {
    throw ApiError.badRequest(body?.message || 'OTP verification failed.');
  }

  const data = body.data;
  const imageUrl = normaliseProfileImage(data.profile_image);

  /// Read back the Aadhaar number from the pending row (we stored it
  /// in `generateAadhaarOtp` before sending the OTP). QuickeKYC's
  /// response masks all but the last four digits, so the row is the
  /// canonical 12-digit value we'll uniqueness-check against.
  const pending = await prisma.partnerDocument.findUnique({
    where: { partnerId: Number(partnerId) },
    select: { aadharNumber: true },
  });
  if (pending?.aadharNumber) {
    await ensureNumberAvailable({
      partnerId,
      field: 'aadharNumber',
      verifiedField: 'aadharVerifiedAt',
      value: pending.aadharNumber,
      label: 'Aadhaar number',
    });
  }

  const noteJson = {
    fullName: data.full_name ?? null,
    dob: data.dob ?? null,
    gender: data.gender ?? null,
    address: data.address ?? null,
    referenceId: data.reference_id ?? null,
    verifiedAt: new Date().toISOString(),
  };

  await prisma.partnerDocument.update({
    where: { partnerId: Number(partnerId) },
    data: {
      kycProvider: PROVIDER,
      kycStatus: 'verified',
      kycVerifiedAt: new Date(),
      kycRejectedAt: null,
      kycNote: JSON.stringify(noteJson),
      /// Mark Aadhaar specifically verified so per-doc badges and
      /// the uniqueness check above can rely on a definite signal.
      aadharVerifiedAt: new Date(),
      /// QuickeKYC's `profile_image` is the holder's face crop from
      /// UIDAI — not a full Aadhaar card scan. Storing it as the
      /// partner's `selfieUrl` (their profile photo) is the honest
      /// placement: it IS their official photo, just sourced from a
      /// government record instead of a phone camera. We don't write
      /// to `aadharImageUrl` since QuickeKYC doesn't expose the full
      /// card image.
      ...(imageUrl ? { selfieUrl: imageUrl } : {}),
    },
  });

  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: Number(partnerId),
    type: 'kyc',
    title: 'Aadhaar verified',
    body: 'Your Aadhaar has been verified successfully.',
  });

  return {
    verified: true,
    fullName: data.full_name ?? null,
    dob: data.dob ?? null,
    gender: data.gender ?? null,
    address: data.address ?? null,
    imageUrl,
  };
};

/// Save the front + back Aadhaar card photos AFTER OTP verification.
/// The presigned upload happens client-side; this endpoint just
/// records the resulting S3 URLs onto PartnerDocument so admin can
/// view them. Refuses to save if the partner hasn't already verified
/// their Aadhaar (no point storing photos for an unverified row).
exports.saveAadhaarPhotos = async ({ partnerId, imageUrl, backImageUrl }) => {
  if (!imageUrl || !backImageUrl) {
    throw ApiError.badRequest('Both front and back photos are required.');
  }
  const existing = await prisma.partnerDocument.findUnique({
    where: { partnerId: Number(partnerId) },
    select: { aadharVerifiedAt: true },
  });
  if (!existing?.aadharVerifiedAt) {
    throw ApiError.badRequest('Verify your Aadhaar via OTP before uploading photos.');
  }
  await prisma.partnerDocument.update({
    where: { partnerId: Number(partnerId) },
    data: {
      aadharImageUrl: imageUrl,
      aadharBackImageUrl: backImageUrl,
    },
  });
  return { ok: true };
};

/// PAN verification. Single-shot — no OTP. Uses QuickeKYC's "PAN
/// Lite" endpoint (`/api/v1/pan/pan`) which returns only the
/// verified PAN number, holder's full name, and category. We don't
/// need DOB / gender / address for partner onboarding, and Lite
/// costs less credit per call than `pan_advance`.
exports.verifyPan = async ({ partnerId, panNumber, imageUrl }) => {
  ensureConfigured();
  const pan = String(panNumber).toUpperCase().replace(/\s/g, '');
  /// 10-char ABCDE1234F format. Stop obvious typos before hitting
  /// the third-party (saves credit + latency).
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    throw ApiError.badRequest('PAN must follow ABCDE1234F format.');
  }
  if (!imageUrl) {
    throw ApiError.badRequest('PAN card photo is required.');
  }

  const { body } = await post('/api/v1/pan/pan', { id_number: pan });
  if (body?.status !== 'success' || !body?.data) {
    throw ApiError.badRequest(body?.message || 'PAN verification failed.');
  }

  /// Uniqueness check — same PAN can't be verified across two partner
  /// accounts. Runs after the API confirms validity to avoid a wasted
  /// QuickeKYC credit on a duplicate that would have been rejected.
  await ensureNumberAvailable({
    partnerId,
    field: 'panNumber',
    verifiedField: 'panVerifiedAt',
    value: pan,
    label: 'PAN',
  });

  const data = body.data;
  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      panNumber: pan,
      panImageUrl: imageUrl,
      kycProvider: PROVIDER,
      panVerifiedAt: new Date(),
    },
    update: {
      panNumber: pan,
      panImageUrl: imageUrl,
      kycProvider: PROVIDER,
      panVerifiedAt: new Date(),
    },
  });

  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: Number(partnerId),
    type: 'kyc',
    title: 'PAN verified',
    body: `PAN verified${data.full_name ? ` for ${data.full_name}` : ''}.`,
  });

  return {
    verified: true,
    fullName: data.full_name ?? null,
    category: data.category ?? null,
  };
};

/// DL verification — number + DOB are both required; QuickeKYC
/// returns 422 with "Please Pass Valid Date of Birth" when DOB is
/// malformed or doesn't match the record.
exports.verifyDrivingLicense = async ({ partnerId, dlNumber, dob, imageUrl: cardImageUrl }) => {
  ensureConfigured();
  const dl = String(dlNumber).toUpperCase().replace(/\s/g, '');
  if (dl.length < 5) {
    throw ApiError.badRequest('Driving license number looks too short.');
  }
  /// QuickeKYC expects YYYY-MM-DD.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dob))) {
    throw ApiError.badRequest('Date of birth must be in YYYY-MM-DD format.');
  }
  if (!cardImageUrl) {
    throw ApiError.badRequest('Driving license photo is required.');
  }

  const { body } = await post('/api/v1/driving-license/driving-license', {
    id_number: dl,
    dob: String(dob),
  });
  if (body?.status !== 'success' || !body?.data) {
    throw ApiError.badRequest(body?.message || 'DL verification failed.');
  }

  /// QuickeKYC sometimes returns status_code 422 inside a "success"
  /// envelope when the DL number is malformed but their parser
  /// didn't reject outright — guard explicitly on the presence of
  /// the holder's name.
  const data = body.data;
  if (!data.name) {
    throw ApiError.badRequest('DL verification failed. Check the number and date of birth.');
  }

  /// Uniqueness check — a verified DL number can't be claimed by
  /// two partners. Runs after the API confirms validity so we don't
  /// burn a credit on a duplicate.
  await ensureNumberAvailable({
    partnerId,
    field: 'dlNumber',
    verifiedField: 'dlVerifiedAt',
    value: dl,
    label: 'Driving license',
  });

  const imageUrl = normaliseProfileImage(data.profile_image);

  /// Decide where the DL photo goes. It's the holder's face (RTO
  /// portrait), not a card scan, so semantically it's a profile
  /// photo. We only write it to `selfieUrl` when the partner doesn't
  /// already have one — Aadhaar verification is the higher-trust
  /// source (UIDAI) so its photo wins if it ran first.
  const existing = await prisma.partnerDocument.findUnique({
    where: { partnerId: Number(partnerId) },
    select: { selfieUrl: true },
  });
  const writeSelfie = imageUrl && !existing?.selfieUrl;

  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      dlNumber: dl,
      dlImageUrl: cardImageUrl,
      kycProvider: PROVIDER,
      dlVerifiedAt: new Date(),
      ...(writeSelfie ? { selfieUrl: imageUrl } : {}),
    },
    update: {
      dlNumber: dl,
      dlImageUrl: cardImageUrl,
      kycProvider: PROVIDER,
      dlVerifiedAt: new Date(),
      ...(writeSelfie ? { selfieUrl: imageUrl } : {}),
    },
  });

  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: Number(partnerId),
    type: 'kyc',
    title: 'Driving license verified',
    body: 'Your driving license has been verified.',
  });

  return {
    verified: true,
    fullName: data.name ?? null,
    dob: data.dob ?? null,
    state: data.state ?? null,
    vehicleClasses: data.vehicle_classes ?? [],
    issuedOn: data.doi ?? null,
    expiresOn: data.doe ?? null,
    imageUrl,
  };
};

/// Bank account verification — penny-drop / NPCI lookup via QuickeKYC's
/// `/api/v1/bank-verification`. Confirms the account exists at the
/// given IFSC and returns the registered holder name. We snapshot the
/// name + bankVerifiedAt on PartnerDocument so admin can confirm the
/// payout target before any money moves.
///
/// IFSC sanity: 11 chars, ABCD0123456 — 4 letters then 0 then 6
/// alphanumerics. Stop typos before hitting QuickeKYC (saves credit).
exports.verifyBankAccount = async ({ partnerId, accountNumber, ifsc, imageUrl }) => {
  ensureConfigured();
  const acc = String(accountNumber ?? '').replace(/\s/g, '');
  const code = String(ifsc ?? '').toUpperCase().replace(/\s/g, '');
  if (!/^\d{6,20}$/.test(acc)) {
    throw ApiError.badRequest('Account number must be 6-20 digits.');
  }
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) {
    throw ApiError.badRequest('IFSC must follow ABCD0XXXXXX format (4 letters, 0, 6 alphanumeric).');
  }
  if (!imageUrl) {
    throw ApiError.badRequest('Bank passbook / cancelled cheque photo is required.');
  }

  /// Uniqueness — a verified account+IFSC pair can't be claimed by
  /// two partners. Bank-side, two people CAN share an account
  /// (joint), but for our payout audit trail we only want one
  /// partner attached.
  const existing = await prisma.partnerDocument.findFirst({
    where: {
      bankAccount: acc,
      bankIfsc: code,
      bankVerifiedAt: { not: null },
      partnerId: { not: Number(partnerId) },
    },
    select: { partnerId: true },
  });
  if (existing) {
    throw new ApiError(
      409,
      'This bank account is already verified on another partner account. ' +
        'Contact support if you believe this is a mistake.',
    );
  }

  const { body } = await post('/api/v1/bank-verification', {
    id_number: acc,
    ifsc: code,
  });
  if (body?.status !== 'success' || !body?.data) {
    throw ApiError.badRequest(body?.message || 'Bank verification failed.');
  }

  const data = body.data;
  /// QuickeKYC sometimes returns `account_exists: false` inside a
  /// status='success' envelope (the API call succeeded but the
  /// account couldn't be confirmed). Guard explicitly — without this
  /// we'd happily save a non-existent account.
  if (data.account_exists === false) {
    throw ApiError.badRequest(
      data.remarks ||
        'This account number + IFSC combination could not be verified at the bank. Please check both and try again.',
    );
  }

  const holderName = data.full_name ? String(data.full_name).trim() : null;
  if (!holderName) {
    throw ApiError.badRequest('Bank returned no holder name — please double-check the account number and IFSC.');
  }

  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      bankAccount: acc,
      bankIfsc: code,
      bankAccountHolder: holderName,
      bankPassbookUrl: imageUrl,
      kycProvider: PROVIDER,
      bankVerifiedAt: new Date(),
    },
    update: {
      bankAccount: acc,
      bankIfsc: code,
      bankAccountHolder: holderName,
      bankPassbookUrl: imageUrl,
      kycProvider: PROVIDER,
      bankVerifiedAt: new Date(),
    },
  });

  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: Number(partnerId),
    type: 'kyc',
    title: 'Bank account verified',
    body: `Bank account verified for ${holderName}.`,
  });

  return {
    verified: true,
    accountHolder: holderName,
    upiId: data.upi_id ?? null,
    remarks: data.remarks ?? null,
  };
};
