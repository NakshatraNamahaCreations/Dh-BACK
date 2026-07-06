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
 *      number + name + DOB onto PartnerDocument and mark Aadhaar
 *      specifically verified. The aggregate kycStatus remains pending
 *      until bank verification succeeds.
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
const { nameSimilarity, NAME_MATCH_THRESHOLD } = require('./nameMatch');

const PROVIDER = 'quickekyc';

/// Look up the partner's UIDAI-verified name (set on Aadhaar OTP submit).
/// Returns null if Aadhaar wasn't verified yet on this account — in
/// which case downstream KYC checks skip the name match (there's nothing
/// to compare against). Legacy partners verified before the aadharName
/// migration also fall through this null path.
const getAadhaarVerifiedName = async (partnerId) => {
  const doc = await prisma.partnerDocument.findUnique({
    where: { partnerId: Number(partnerId) },
    select: { aadharName: true },
  });
  return doc?.aadharName ?? null;
};

/// Throws if the holder name returned by QuickeKYC for a non-Aadhaar
/// doc doesn't match the partner's Aadhaar-verified name. Backend-side
/// enforcement is the source of truth — the partner-app does the same
/// check for fast UX, but only this gate prevents the verified-at
/// timestamp from being written. `docLabel` shapes the error message
/// ("DL", "PAN", "bank account") so it's actionable for the partner.
const assertNameMatchesAadhaar = async ({ partnerId, holderName, docLabel }) => {
  if (!holderName) return;
  const aadhaarName = await getAadhaarVerifiedName(partnerId);
  if (!aadhaarName) return; /// Aadhaar not verified or legacy row — skip.
  const sim = nameSimilarity(holderName, aadhaarName);
  if (sim < NAME_MATCH_THRESHOLD) {
    logger.warn(
      `[kyc] ${docLabel} name-match=${Math.round(sim * 100)}% (need ≥${Math.round(
        NAME_MATCH_THRESHOLD * 100,
      )}%) — "${holderName}" vs Aadhaar "${aadhaarName}"`,
    );
    throw ApiError.badRequest(
      `Name on ${docLabel} "${holderName}" doesn't match your Aadhaar name "${aadhaarName}". ` +
        `Please ensure you're using your own ${docLabel}.`,
    );
  }
};

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
exports.generateAadhaarOtp = async ({ partnerId, aadhaarNumber, imageUrl, backImageUrl }) => {
  ensureConfigured();
  const digits = String(aadhaarNumber).replace(/\D/g, '');
  if (digits.length !== 12) {
    throw ApiError.badRequest('Aadhaar number must be 12 digits.');
  }
  if (!imageUrl) {
    throw ApiError.badRequest('Front-of-Aadhaar photo is required.');
  }
  if (!backImageUrl) {
    throw ApiError.badRequest('Back-of-Aadhaar photo is required.');
  }

  /// OCR gate — HARD block (re-tightened 2026-07-06 by admin decision;
  /// previously a soft-warn, which let a partner attach any random
  /// photo and still reach the OTP step — the wrong image was only
  /// caught later in manual admin review).
  ///
  ///   - FRONT: the typed 12-digit number must be readable in the photo
  ///     (with the OCR class-map + fuzzy/digit-run tolerances).
  ///   - BACK: must read as an Aadhaar back — the same number OR the
  ///     mandatory UIDAI template markers (some layouts don't repeat
  ///     the number on the back, so markers count too).
  ///
  /// Infrastructure failures (image fetch error, OCR worker crash)
  /// still fail OPEN: a real partner shouldn't be blocked because S3 or
  /// tesseract hiccuped — the OTP-to-linked-mobile flow remains the
  /// primary identity check regardless. Only a successful OCR pass that
  /// genuinely can't find the number/markers blocks the request.
  const ocr = require('./ocr.service');
  const [frontOcr, backOcr] = await Promise.all([
    ocr.numberExistsInImage(imageUrl, digits).catch((err) => {
      logger.warn(`[kyc] front OCR errored for partner ${partnerId} — failing open: ${err.message}`);
      return { found: true };
    }),
    ocr.aadhaarBackMarkersInImage(backImageUrl, digits).catch((err) => {
      logger.warn(`[kyc] back OCR errored for partner ${partnerId} — failing open: ${err.message}`);
      return { found: true };
    }),
  ]);
  if (!frontOcr.found) {
    logger.warn(`[kyc] OCR gate BLOCKED front image for partner ${partnerId} (number not found).`);
    throw ApiError.badRequest(
      'We could not find the Aadhaar number you entered on the front photo. Upload a clear, well-lit photo of the FRONT of your Aadhaar card and make sure it matches the number you typed.',
    );
  }
  if (!backOcr.found) {
    logger.warn(`[kyc] OCR gate BLOCKED back image for partner ${partnerId} (no number / UIDAI markers).`);
    throw ApiError.badRequest(
      'The back photo does not look like an Aadhaar card. Upload a clear, well-lit photo of the BACK of your Aadhaar card.',
    );
  }

  const { body } = await post('/api/v1/aadhaar-v2/generate-otp', { id_number: digits });
  if (body?.status !== 'success' || !body?.request_id) {
    throw ApiError.badRequest(body?.message || 'Could not send Aadhaar OTP. Check the number.');
  }

  const existingDoc = await prisma.partnerDocument.findUnique({
    where: { partnerId: Number(partnerId) },
    select: { bankVerifiedAt: true, kycVerifiedAt: true },
  });

  /// Stash the in-flight Aadhaar number + both photo URLs against the
  /// request_id on the partner row so step 2 can verify the OTP came
  /// from the same intent. submit-otp overwrites `selfieUrl` with the
  /// UIDAI face crop separately, but the partner-supplied card scans
  /// stay on `aadharImageUrl` / `aadharBackImageUrl`.
  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      aadharNumber: digits,
      aadharImageUrl: imageUrl,
      aadharBackImageUrl: backImageUrl,
      kycProvider: PROVIDER,
      kycStatus: 'pending',
    },
    update: {
      aadharNumber: digits,
      aadharImageUrl: imageUrl,
      aadharBackImageUrl: backImageUrl,
      kycProvider: PROVIDER,
      kycStatus: existingDoc?.bankVerifiedAt ? 'verified' : 'pending',
      kycVerifiedAt: existingDoc?.bankVerifiedAt ? (existingDoc.kycVerifiedAt ?? existingDoc.bankVerifiedAt) : null,
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
/// full profile and snapshot the key fields onto PartnerDocument.
/// Aadhaar gets its own verified timestamp, but the aggregate
/// `kycStatus` stays pending until the final bank verification step.
/// The holder's photo (`profile_image`) is saved straight into
/// `aadharImageUrl` so the partner doesn't have to upload an Aadhaar
/// card scan separately.
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
    select: { aadharNumber: true, bankVerifiedAt: true, kycVerifiedAt: true },
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

  /// Gate the verified write on Basic-Details-name match. UIDAI OTP
  /// proves the partner owns the Aadhaar mobile, but the *name* they
  /// typed in the Personal Info screen might differ from the UIDAI
  /// record (typo, nickname, missing surname). Without this gate the
  /// row gets marked verified even when the partner saw a mismatch
  /// error in the app — admin would then see "Verified" on what the
  /// partner believed was rejected.
  ///
  /// Marker phrase `Aadhaar name` in the message is what the partner-app
  /// matches on to show the "Go to Basic Details" CTA, so keep the
  /// wording consistent here.
  const aadhaarFullName = data.full_name ? String(data.full_name).trim() : null;
  if (aadhaarFullName) {
    const partner = await prisma.partner.findUnique({
      where: { id: Number(partnerId) },
      select: { name: true },
    });
    if (partner?.name) {
      const sim = nameSimilarity(aadhaarFullName, partner.name);
      if (sim < NAME_MATCH_THRESHOLD) {
        logger.warn(
          `[kyc.aadhaar] name-match=${Math.round(sim * 100)}% (need ≥${Math.round(
            NAME_MATCH_THRESHOLD * 100,
          )}%) — Aadhaar "${aadhaarFullName}" vs profile "${partner.name}"`,
        );
        /// Mark the row explicitly rejected BEFORE throwing so admin UI
        /// shows "Rejected" instead of stale "Pending" / a leftover
        /// "Verified" badge from a prior attempt. aadharVerifiedAt
        /// stays null. kycNote captures the reason for admin review.
        const rejectMessage = `Name mismatch — Aadhaar "${aadhaarFullName}" vs profile "${partner.name}"`;
        await prisma.partnerDocument.update({
          where: { partnerId: Number(partnerId) },
          data: {
            kycProvider: PROVIDER,
            kycStatus: 'rejected',
            kycRejectedAt: new Date(),
            kycVerifiedAt: null,
            aadharVerifiedAt: null,
            kycNote: rejectMessage,
          },
        });
        throw ApiError.badRequest(
          `Name on Aadhaar "${aadhaarFullName}" doesn't match your profile name "${partner.name}". ` +
            `Please update your name in Basic Details to match your Aadhaar, then verify again.`,
        );
      }
    }
  }

  /// Flatten the Aadhaar address object into a single human-readable
  /// string. QuickeKYC returns it as { house, street, landmark, vtc,
  /// po, district, subdist, state, country, pincode } — null fields
  /// are dropped, present ones are joined with ", " in mailing order.
  const flattenAddress = (addr) => {
    if (!addr || typeof addr !== 'object') return null;
    const parts = [
      addr.house,
      addr.street,
      addr.landmark,
      addr.vtc,
      addr.po,
      addr.subdist,
      addr.district,
      addr.state,
      addr.country,
      addr.pincode,
    ]
      .map((p) => (p ? String(p).trim() : ''))
      .filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  };

  await prisma.partnerDocument.update({
    where: { partnerId: Number(partnerId) },
    data: {
      kycProvider: PROVIDER,
      kycStatus: pending?.bankVerifiedAt ? 'verified' : 'pending',
      kycVerifiedAt: pending?.bankVerifiedAt ? (pending.kycVerifiedAt ?? pending.bankVerifiedAt) : null,
      kycRejectedAt: null,
      /// Clear the rejection note from any prior name-mismatch attempt
      /// — the partner has now successfully re-verified after fixing
      /// their Basic Details name.
      kycNote: null,
      /// Mark Aadhaar specifically verified so per-doc badges and
      /// the uniqueness check above can rely on a definite signal.
      aadharVerifiedAt: new Date(),
      /// Extracted snapshot fields. Captured here so admin can display
      /// + filter without re-calling QuickeKYC.
      aadharName: data.full_name ? String(data.full_name).trim() : null,
      aadharDob: data.dob ?? null,
      aadharGender: data.gender ?? null,
      aadharAddress: flattenAddress(data.address),
      /// `selfieUrl` and the full provider payload are deliberately
      /// NOT persisted — every QuickeKYC field we care about is already
      /// captured by the four columns above. Storing the JSON again
      /// would just duplicate the data.
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
    select: { aadharVerifiedAt: true, aadharNumber: true },
  });
  if (!existing?.aadharVerifiedAt) {
    throw ApiError.badRequest('Verify your Aadhaar via OTP before uploading photos.');
  }

  /// OCR check — soft-warn, not a hard block. Aadhaar has already
  /// been verified via OTP at this point (the `aadharVerifiedAt`
  /// check above), so OCR here is purely a "the photo matches the
  /// number we already verified" sanity check. Gallery-edited /
  /// compressed images often fail OCR even when they're the real
  /// card. We log the miss so admin can review if a particular row
  /// looks fishy in the dashboard.
  if (existing.aadharNumber) {
    const ocr = require('./ocr.service');
    const ocrResult = await ocr.numberExistsInImage(imageUrl, existing.aadharNumber).catch(() => ({ found: true }));
    if (!ocrResult.found) {
      logger.warn(
        `[kyc] OCR couldn't find Aadhaar number ${existing.aadharNumber} on uploaded front photo for partner ${partnerId} — proceeding (Aadhaar already OTP-verified).`,
      );
    }
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
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    throw ApiError.badRequest('PAN must follow ABCDE1234F format.');
  }
  if (!imageUrl) {
    throw ApiError.badRequest('PAN card photo is required.');
  }

  /// Run OCR + QuickeKYC in parallel — OCR on the uploaded image,
  /// QuickeKYC against the NSDL database. Both start at the same time
  /// so the OCR check adds zero extra wall-clock latency.
  const ocr = require('./ocr.service');
  const [ocrResult, apiResult] = await Promise.all([
    ocr.numberExistsInImage(imageUrl, pan).catch(() => ({ found: true })),
    post('/api/v1/pan/pan', { id_number: pan }),
  ]);

  if (!ocrResult.found) {
    /// Soft gate — same rationale as DL. Tesseract.js misreads PAN
    /// numbers on real cards often enough that hard-blocking traps
    /// legitimate partners. QuickeKYC's NSDL lookup is the real
    /// truth check, and the downstream Aadhaar-name-match catches
    /// someone uploading another person's PAN. Logged so admin can
    /// audit if needed.
    logger.warn(
      `[kyc.pan] OCR could not detect PAN ${pan} on uploaded image — ` +
      `proceeding because QuickeKYC + name-match will gate identity.`,
    );
  }

  const { body } = apiResult;
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
  const panHolderName = data.full_name ? String(data.full_name).trim() : null;
  /// `address` is only present on pan_advance responses. Lite returns
  /// just full_name + category; the column stays null until the
  /// endpoint is upgraded. Captured here so admin UI doesn't need a
  /// follow-up code change when that flip happens.
  const panAddress = data.address ? String(data.address).trim() : null;
  /// PAN Lite returns a one-word category: person / company / huf /
  /// firm / trust / government / association. Persisting it as a flat
  /// column means we no longer need a raw JSON blob just for this one
  /// field.
  const panCategory = data.category ? String(data.category).trim() : null;

  /// Gate the verified write on Aadhaar name match. Throws on mismatch
  /// — the upsert below never runs and `panVerifiedAt` stays null, so
  /// admin doesn't see a "Verified" badge on a rejected document.
  await assertNameMatchesAadhaar({ partnerId, holderName: panHolderName, docLabel: 'PAN' });
  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      panNumber: pan,
      panImageUrl: imageUrl,
      kycProvider: PROVIDER,
      panVerifiedAt: new Date(),
      ...(panHolderName ? { panHolderName } : {}),
      ...(panAddress ? { panAddress } : {}),
      ...(panCategory ? { panCategory } : {}),
    },
    update: {
      panNumber: pan,
      panImageUrl: imageUrl,
      kycProvider: PROVIDER,
      panVerifiedAt: new Date(),
      /// A successful verify SUPERSEDES any earlier skip (e.g. the partner
      /// skipped PAN during onboarding, then uploaded it from their profile).
      panSkippedAt: null,
      panSkipReason: null,
      ...(panHolderName ? { panHolderName } : {}),
      ...(panAddress ? { panAddress } : {}),
      ...(panCategory ? { panCategory } : {}),
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
  /// QuickeKYC expects YYYY-MM-DD. Partner-app sends DD-MM-YYYY
  /// (natural Indian date entry); admin tooling sends YYYY-MM-DD.
  /// Normalise both to ISO before hitting the provider.
  const dobIso = String(dob).trim();
  let dobForApi;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dobIso)) {
    dobForApi = dobIso;
  } else if (/^\d{2}-\d{2}-\d{4}$/.test(dobIso)) {
    const [dd, mm, yyyy] = dobIso.split('-');
    dobForApi = `${yyyy}-${mm}-${dd}`;
  } else {
    throw ApiError.badRequest('Date of birth must be in DD-MM-YYYY or YYYY-MM-DD format.');
  }
  if (!cardImageUrl) {
    throw ApiError.badRequest('Driving license photo is required.');
  }

  /// OCR + QuickeKYC in parallel — same pattern as PAN.
  /// OCR is a HARD gate for DL: the uploaded photo must actually contain
  /// the DL number, otherwise a partner can pass verification with any
  /// random image (a screenshot, another doc, a photo of a screen) as
  /// long as they TYPE a real DL number — QuickeKYC only checks the
  /// typed number against RTO records, never the photo. The number
  /// matcher has four escalating fallback strategies (exact → fuzzy →
  /// digits → last-8-digits) precisely so glossy/laminated cards with
  /// glare still match, which keeps false-rejections of genuine cards
  /// low while still rejecting wrong uploads.
  ///
  /// `.catch(() => ({ found: true, infraError: true }))` keeps an
  /// infrastructure failure (image URL unreachable, OCR worker crash)
  /// from hard-blocking a real partner — those throw, and we'd rather
  /// fall back to the RTO + Aadhaar-name-match gate than reject on an
  /// S3 hiccup. A clean `found: false` means OCR ran and the number is
  /// genuinely absent — that we DO reject.
  const ocr = require('./ocr.service');
  const [ocrResult, apiResult] = await Promise.all([
    ocr.numberExistsInImage(cardImageUrl, dl).catch((err) => {
      logger.warn(`[kyc.dl] OCR errored for DL ${dl} — passing on infra failure: ${err.message}`);
      return { found: true, infraError: true };
    }),
    post('/api/v1/driving-license/driving-license', { id_number: dl, dob: dobForApi }),
  ]);

  if (!ocrResult.found) {
    logger.warn(
      `[kyc.dl] OCR could not detect DL number ${dl} on uploaded image — rejecting upload.`,
    );
    throw ApiError.badRequest(
      "We couldn't read your driving license number in the photo. Please upload a clear, " +
      'well-lit photo of your actual driving license (not a screenshot or another document).',
    );
  }

  const { body } = apiResult;
  if (body?.status !== 'success' || !body?.data) {
    throw ApiError.badRequest(body?.message || 'DL verification failed.');
  }

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

  const dlHolderName = data.name ? String(data.name).trim() : null;

  /// Gate the verified write on Aadhaar name match. Throws on mismatch
  /// — the upsert below never runs and `dlVerifiedAt` stays null, so
  /// admin doesn't see a "Verified" badge on a rejected document.
  await assertNameMatchesAadhaar({ partnerId, holderName: dlHolderName, docLabel: 'driving license' });

  /// Keep only the DL permanent address from QuickeKYC. Other DL
  /// profile fields are deliberately not stored.
  const dlSnapshot = {
    dlPermanentAddress: data.permanent_address ?? null,
  };

  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      dlNumber: dl,
      dlImageUrl: cardImageUrl,
      kycProvider: PROVIDER,
      dlVerifiedAt: new Date(),
      dlSkippedAt: null,
      dlSkipReason: null,
      ...dlSnapshot,
      ...(dlHolderName ? { dlHolderName } : {}),
    },
    update: {
      dlNumber: dl,
      dlImageUrl: cardImageUrl,
      kycProvider: PROVIDER,
      dlVerifiedAt: new Date(),
      dlSkippedAt: null,
      dlSkipReason: null,
      ...dlSnapshot,
      ...(dlHolderName ? { dlHolderName } : {}),
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
    /// imageUrl intentionally dropped — we no longer persist the RTO
    /// portrait or expose it back to the client.
    imageUrl: null,
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

  /// Gate the verified write on Aadhaar name match. Throws on mismatch
  /// — the upsert below never runs and `bankVerifiedAt` stays null, so
  /// admin doesn't see a "Verified" badge on a rejected account.
  await assertNameMatchesAadhaar({ partnerId, holderName, docLabel: 'bank account' });

  /// Extracted bank-verify snapshot. `ifsc_details` is whatever
  /// QuickeKYC sends back (branch / city / IFSC metadata when
  /// available) — stored as Json since the shape varies by bank.
  const bankSnapshot = {
    bankAccountExists: typeof data.account_exists === 'boolean' ? data.account_exists : null,
    bankUpiId: data.upi_id ? String(data.upi_id).trim() : null,
    bankRemarks: data.remarks ? String(data.remarks).trim() : null,
    bankIfscDetails: data.ifsc_details && typeof data.ifsc_details === 'object' ? data.ifsc_details : null,
  };

  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: {
      partnerId: Number(partnerId),
      bankAccount: acc,
      bankIfsc: code,
      bankAccountHolder: holderName,
      bankPassbookUrl: imageUrl,
      kycProvider: PROVIDER,
      kycStatus: 'verified',
      kycVerifiedAt: new Date(),
      kycRejectedAt: null,
      kycNote: null,
      bankVerifiedAt: new Date(),
      ...bankSnapshot,
    },
    update: {
      bankAccount: acc,
      bankIfsc: code,
      bankAccountHolder: holderName,
      bankPassbookUrl: imageUrl,
      kycProvider: PROVIDER,
      kycStatus: 'verified',
      kycVerifiedAt: new Date(),
      kycRejectedAt: null,
      kycNote: null,
      bankVerifiedAt: new Date(),
      ...bankSnapshot,
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

/// Skip PAN verification during onboarding. PAN is a SKIPPABLE document —
/// the partner can finish onboarding without it and complete it later from
/// their profile (or an admin can upload it). Sets `panSkippedAt` so the
/// activation gate (auth.service.hasRequiredPartnerDocuments) treats PAN as
/// satisfied, while the profile nudge still counts it incomplete until it's
/// actually verified. No QuickeKYC call — just a state flag.
///   `by` distinguishes who skipped ('partner' | 'admin') in the reason.
exports.skipPan = async ({ partnerId, reason, by = 'partner' }) => {
  const note = reason?.trim() || `Skipped by ${by}`;
  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: { partnerId: Number(partnerId), panSkippedAt: new Date(), panSkipReason: note },
    update: { panSkippedAt: new Date(), panSkipReason: note },
  });
  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: Number(partnerId),
    type: 'kyc',
    title: 'PAN step skipped',
    body: 'You can add your PAN later from your profile to complete verification.',
  });
  return { skipped: true };
};

/// Skip DL verification during onboarding — same model as skipPan. (Admin
/// already has a separate skip via partners.service.skipDlVerification; this
/// is the PARTNER-initiated self-skip during onboarding.)
exports.skipDl = async ({ partnerId, reason, by = 'partner' }) => {
  const note = reason?.trim() || `Skipped by ${by}`;
  await prisma.partnerDocument.upsert({
    where: { partnerId: Number(partnerId) },
    create: { partnerId: Number(partnerId), dlSkippedAt: new Date(), dlSkipReason: note },
    update: { dlSkippedAt: new Date(), dlSkipReason: note },
  });
  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: Number(partnerId),
    type: 'kyc',
    title: 'Driving license step skipped',
    body: 'You can add your driving license later from your profile.',
  });
  return { skipped: true };
};
