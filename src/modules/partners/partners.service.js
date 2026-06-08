const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

/// Onboarding-pipeline stages — must match the frontend's
/// `STAGE_ORDER` in `admin-panel/src/data/mock.ts`. When a partner row
/// is enriched into the admin shape, we emit one entry per key here.
/// `training` and `payment` were dropped — they were vestigial and
/// always rendered as blank cards on the partner detail because the
/// frontend never had matching labels for them.
const STAGE_KEYS = [
  'application',
  'aadhaar',
  'pan',
  'dl',
  'background',
  'call',
  'bank',
  /// `fee` — admin enters the kit + onboarding fee amount.
  /// `payment` — partner has paid that amount.
  /// `training` — admin marked the in-person/video training done.
  /// `activated` — admin flipped the partner to live access.
  'fee',
  'payment',
  'training',
  'activated',
];

const stableHash = (input) => {
  const s = String(input);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
};

const categoryMap = async () => {
  const categories = await prisma.category.findMany({ select: { id: true, name: true } });
  return new Map(categories.map((c) => [c.id, c.name]));
};

const categoryName = (p, categoryById) =>
  p.categoryId && categoryById.has(p.categoryId) ? categoryById.get(p.categoryId) : 'Unassigned';

const docState = (value) => (value ? 'uploaded' : 'pending');

const isDlComplete = (doc) => Boolean(doc?.dlVerifiedAt || doc?.dlSkippedAt);
/// PAN, like DL, is complete when verified OR skipped (skippable doc).
const isPanComplete = (doc) => Boolean(doc?.panVerifiedAt || doc?.panSkippedAt);

const hasRequiredDocuments = (doc) =>
  Boolean(doc?.aadharNumber && isPanComplete(doc) && isDlComplete(doc) && doc?.bankAccount && doc?.bankIfsc);

/// Minimal PartnerDocument projection for LIST views. The directory /
/// onboarding lists only render per-document STATUS + a bank last-4 +
/// selfie — they never need the full row (no kycNote JSON blob, provider
/// fields, holder names, address snapshots, raw image URLs beyond presence).
/// `include: { document: true }` pulled Aadhaar/PAN/DL numbers, bank
/// details and the provider JSON for every row on every page; this select
/// is the exact set the list shapers read (enrichPartner + its helpers).
const LIST_DOCUMENT_SELECT = {
  // status / completeness signals
  aadharNumber: true,
  aadharImageUrl: true,
  aadharVerifiedAt: true,
  panNumber: true,
  panImageUrl: true,
  panVerifiedAt: true,
  panSkippedAt: true,
  dlNumber: true,
  dlImageUrl: true,
  dlVerifiedAt: true,
  dlSkippedAt: true,
  bankAccount: true, // sliced to last-4 in the shape, not exposed whole
  bankIfsc: true,
  kycStatus: true,
  selfieUrl: true,
};

const onboardingStatus = (p) => {
  if (p.rejectedReason || !p.isActive) return 'rejected';
  if (p.isVerified) return 'approved';
  if (p.callVerified) return 'in_review';
  return 'pending';
};

const kycStatus = (p) => {
  if (p.isVerified) return 'verified';
  if (p.rejectedReason || p.document?.kycStatus === 'rejected') return 'rejected';
  return p.document?.kycStatus === 'verified' ? 'verified' : 'pending';
};

const stagesForPartner = (p, updatedBy = 'System') => {
  const done = new Set(['application']);
  const doc = p.document;
  if (doc?.aadharNumber) done.add('aadhaar');
  if (isPanComplete(doc) || doc?.panNumber || doc?.panImageUrl) done.add('pan');
  if (isDlComplete(doc) || doc?.dlNumber || doc?.dlImageUrl) done.add('dl');
  if (doc?.kycStatus === 'verified' || hasRequiredDocuments(doc)) done.add('background');
  if (p.callVerified) done.add('call');
  if (doc?.bankAccount && doc?.bankIfsc) done.add('bank');
  if (p.onboardingFeeAmount != null) done.add('fee');
  if (p.paymentStatus === 'paid') done.add('payment');
  if (p.trainingCompletedAt != null) done.add('training');
  if (p.isVerified) done.add('activated');

  return STAGE_KEYS.map((key) => ({
    key,
    status: done.has(key) ? 'done' : p.rejectedReason ? 'failed' : 'pending',
    updatedAt: done.has(key) ? p.updatedAt.toISOString() : undefined,
    updatedBy: done.has(key) ? updatedBy : undefined,
    note: key === 'activated' && p.rejectedReason ? p.rejectedReason : undefined,
  }));
};

const documentsForPartner = (p) => ({
  aadhaar: docState(p.document?.aadharNumber || p.document?.aadharImageUrl),
  pan: p.document?.panSkippedAt
    ? 'skipped'
    : docState(p.document?.panNumber || p.document?.panImageUrl),
  dl: p.document?.dlSkippedAt ? 'skipped' : docState(p.document?.dlNumber || p.document?.dlImageUrl),
});

const enrichPartner = (p, categoryById, jobsCount = 0, earnings = 0) => {
  const h = stableHash(p.id);
  return {
    id: p.id,
    name: p.name ?? p.businessName ?? 'Unnamed partner',
    phone: p.phone,
    email: p.email ?? '',
    /// `categoryId` powers the admin panel's "Change category"
    /// dropdown — without the raw id the form has no way to
    /// pre-select the partner's current trade. `category` (string
    /// name) stays for table/header rendering.
    categoryId: p.categoryId ?? null,
    category: categoryName(p, categoryById),
    /// `city` keeps the legacy free-text fallback so older UI cells
    /// don't break; `cityName` + `state` come from the Geography join
    /// and drive the new Location column on every admin table.
    city: p.cityRef?.name ?? p.city ?? 'Not set',
    cityName: p.cityRef?.name ?? p.city ?? null,
    state: p.cityRef?.state?.name ?? null,
    stateCode: p.cityRef?.state?.code ?? null,
    rating: p.avgRating ?? 0,
    ratingCount: p.ratingCount ?? 0,
    jobsCompleted: jobsCount,
    earnings,
    /// Admin-side status mapping. Decision tree:
    ///   - isActive=false + suspendReason → 'suspended'
    ///   - isActive=false (no reason)     → 'paused'
    ///   - isActive=true + isVerified=false → 'onboarding'
    ///       (partner row exists but hasn't been fully approved —
    ///        any of: docs not done, fee not set, fee not paid,
    ///        training not done, admin hasn't activated. The
    ///        directory should NOT show this row as "Active" while
    ///        these steps are pending; the partner can't actually
    ///        receive jobs yet.)
    ///   - isActive=true + isVerified=true → 'active'
    /// UI renders a Resume / Suspend toggle accordingly.
    status: !p.isActive
      ? p.suspendReason
        ? 'suspended'
        : 'paused'
      : p.isVerified
        ? 'active'
        : 'onboarding',
    suspendReason: p.suspendReason ?? null,
    suspendedAt: p.suspendedAt ?? null,
    /// Real-time duty mirror (kept in sync from the Redis presence
    /// layer). Lets the directory show an On Duty / Off Duty badge and
    /// filter by it. Reflects whether the partner is currently online +
    /// available for dispatch; may briefly lag a crash until the
    /// reconciler flips a stale row off.
    onDuty: p.onDuty ?? false,
    /// 3-state live status: 'off_duty' | 'available' (on duty, free) |
    /// 'busy' (on duty + on a job). Superset of `onDuty`.
    dutyState: p.dutyState ?? 'off_duty',
    onDutyChangedAt: p.onDutyChangedAt ?? null,
    kyc: kycStatus(p),
    joinedAt: p.createdAt.toISOString().slice(0, 10),
    bankName: p.document?.bankIfsc ? 'Bank account on file' : undefined,
    bankAccountLast4: p.document?.bankAccount ? p.document.bankAccount.slice(-4) : undefined,
    ifsc: p.document?.bankIfsc,
    address: p.city ?? undefined,
    /// Profile photo (selfie) captured during onboarding or via the
    /// partner-app's Profile edit screen. Surfaced on the admin
    /// directory + details page so ops can put a face to the row.
    selfieUrl: p.document?.selfieUrl ?? null,
  };
};

const bookingStats = async (partnerIds) => {
  if (partnerIds.length === 0) return new Map();
  const rows = await prisma.booking.groupBy({
    by: ['partnerId'],
    where: {
      partnerId: { in: partnerIds },
      status: 'COMPLETED',
    },
    _count: { _all: true },
    _sum: { total: true },
  });
  return new Map(rows.map((r) => [r.partnerId, {
    jobs: r._count._all,
    earnings: r._sum.total ?? 0,
  }]));
};

exports.list = async ({ status, kyc, search, onDuty, dutyState, scope, page = 1, pageSize = 25 } = {}) => {
  const { applyScopeToWhere } = require('../../middlewares/adminScope');
  const where = {};
  /// Duty filters — both AND with status.
  ///   `dutyState` (preferred): exact 3-state filter
  ///     'available' (on duty + free) | 'busy' (on a job) | 'off_duty'.
  ///   `onDuty` (legacy boolean): true → on duty (available OR busy).
  if (['off_duty', 'available', 'busy'].includes(dutyState)) {
    where.dutyState = dutyState;
  } else if (onDuty === true || onDuty === 'true') {
    where.dutyState = { in: ['available', 'busy'] };
  } else if (onDuty === false || onDuty === 'false') {
    where.dutyState = 'off_duty';
  }
  /// Status filter:
  ///   - 'active'      → isActive=true AND isVerified=true (fully approved + live)
  ///   - 'onboarding'  → isActive=true AND isVerified=false (in-flight)
  ///   - 'paused' / 'suspended' → isActive=false (UI distinguishes via suspendReason)
  if (status === 'active') {
    where.isActive = true;
    where.isVerified = true;
  } else if (status === 'onboarding') {
    where.isActive = true;
    where.isVerified = false;
  } else if (status === 'paused' || status === 'suspended') {
    where.isActive = false;
  }
  if (kyc === 'verified') where.isVerified = true;
  if (kyc === 'pending') where.isVerified = false;
  /// 'rejected' = has a rejection reason OR the document's kycStatus is
  /// 'rejected' (mirrors the kycStatus() shape helper). Filtered in the DB
  /// so pagination + total are correct — previously this filtered the
  /// already-paged result, producing short pages and a wrong total.
  if (kyc === 'rejected') {
    where.OR = [
      ...(where.OR ?? []),
      { rejectedReason: { not: null } },
      { document: { kycStatus: 'rejected' } },
    ];
  }
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (scope) applyScopeToWhere(where, scope);

  const [items, total, categoryById] = await Promise.all([
    prisma.partner.findMany({
      where,
      include: {
        document: { select: LIST_DOCUMENT_SELECT },
        cityRef: { select: { name: true, state: { select: { name: true, code: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.partner.count({ where }),
    categoryMap(),
  ]);
  const stats = await bookingStats(items.map((p) => p.id));
  const data = items.map((p) => {
    const s = stats.get(p.id) ?? { jobs: 0, earnings: 0 };
    return enrichPartner(p, categoryById, s.jobs, s.earnings);
  });
  /// NOTE: the 'rejected' kyc filter now lives in the `where` above, so the
  /// page + total are computed over the filtered set. No post-fetch filter.

  return {
    data,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

/// Full document detail returned to admin views — numbers and image
/// URLs as stored. Admin needs the unmasked values to cross-check
/// against the uploaded image; the customer-app and partner-app
/// never receive this shape.
/// Flatten QuickeKYC's nested address object into a single readable
/// line. Fields are ordered from specific → broad so the string reads
/// naturally (house → street → landmark → locality → city → district
/// → state → country). Null / empty parts are silently dropped.
const formatAadhaarAddress = (addr) => {
  if (!addr || typeof addr !== 'object') return null;
  const parts = [
    addr.house,
    addr.street,
    addr.landmark,
    addr.loc,
    addr.vtc,
    addr.po,
    addr.subdist,
    addr.dist,
    addr.state,
    addr.country,
  ].filter((v) => v && String(v).trim());
  return parts.length > 0 ? parts.join(', ') : null;
};

const documentDetailsForPartner = (p) => {
  /// Parse kycNote JSON (Aadhaar verification payload). Stored as a
  /// raw string so we can snapshot provider data without schema churn.
  let kycParsed = null;
  try {
    if (p.document?.kycNote) kycParsed = JSON.parse(p.document.kycNote);
  } catch {
    // malformed — treat as absent
  }

  return {
    aadharNumber: p.document?.aadharNumber ?? null,
    panNumber: p.document?.panNumber ?? null,
    dlNumber: p.document?.dlNumber ?? null,
    aadharImageUrl: p.document?.aadharImageUrl ?? null,
    aadharBackImageUrl: p.document?.aadharBackImageUrl ?? null,
    panImageUrl: p.document?.panImageUrl ?? null,
    dlImageUrl: p.document?.dlImageUrl ?? null,
    bankAccount: p.document?.bankAccount ?? null,
    bankIfsc: p.document?.bankIfsc ?? null,
    bankPassbookUrl: p.document?.bankPassbookUrl ?? null,
    signatureUrl: p.document?.signatureUrl ?? null,
    selfieUrl: p.document?.selfieUrl ?? null,
    kycStatus: p.document?.kycStatus ?? null,
    kycVerifiedAt: p.document?.kycVerifiedAt ?? null,
    /// Per-document verification timestamps.
    aadharVerifiedAt: p.document?.aadharVerifiedAt ?? null,
    panVerifiedAt: p.document?.panVerifiedAt ?? null,
    panSkippedAt: p.document?.panSkippedAt ?? null,
    panSkipReason: p.document?.panSkipReason ?? null,
    dlVerifiedAt: p.document?.dlVerifiedAt ?? null,
    dlSkippedAt: p.document?.dlSkippedAt ?? null,
    dlSkipReason: p.document?.dlSkipReason ?? null,
    bankVerifiedAt: p.document?.bankVerifiedAt ?? null,
    /// Verified holder names from QuickeKYC responses.
    panHolderName: p.document?.panHolderName ?? null,
    dlHolderName: p.document?.dlHolderName ?? null,
    bankAccountHolder: p.document?.bankAccountHolder ?? null,
    /// Aadhaar-verified identity fields. Prefer the dedicated columns
    /// (populated by `submitAadhaarOtp` for partners verified after the
    /// 2026-05-20 schema migration); fall back to the legacy kycNote
    /// JSON for partners verified before it. Once all live rows are
    /// migrated forward, the kycNote fallback + the parsing block above
    /// can be removed.
    kycName: p.document?.aadharName ?? kycParsed?.fullName ?? null,
    kycDob: p.document?.aadharDob ?? kycParsed?.dob ?? null,
    kycGender: p.document?.aadharGender ?? kycParsed?.gender ?? null,
    kycAddress: p.document?.aadharAddress ?? formatAadhaarAddress(kycParsed?.address),
  };
};

exports.get = async (id) => {
  const [p, categoryById] = await Promise.all([
    prisma.partner.findUnique({ where: { id: Number(id) }, include: { document: true } }),
    categoryMap(),
  ]);
  if (!p) throw ApiError.notFound('Partner not found');
  const stats = await bookingStats([p.id]);
  const s = stats.get(p.id) ?? { jobs: 0, earnings: 0 };

  /// Last 5 bookings the partner touched — across ALL statuses, so the
  /// admin sees the partner's true recent activity (assigned, in-flight,
  /// completed, cancelled — not just terminal rows). Used to be filtered
  /// to COMPLETED+CANCELLED to dodge a too-narrow admin badge; the badge
  /// now renders every status correctly so the filter can come off.
  const recent = await prisma.booking.findMany({
    where: { partnerId: p.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      status: true,
      total: true,
      grandTotal: true,
      jobCompletedAt: true,
      createdAt: true,
      items: { select: { serviceName: true }, take: 1 },
    },
  });

  return {
    ...enrichPartner(p, categoryById, s.jobs, s.earnings),
    documents: documentsForPartner(p),
    documentDetails: documentDetailsForPartner(p),
    stages: stagesForPartner(p),
    recentJobs: recent.map((b) => ({
      id: String(b.id),
      /// ISO string — the admin renders it through formatDateTimeIST.
      date: (b.jobCompletedAt ?? b.createdAt).toISOString(),
      service: b.items[0]?.serviceName ?? 'Service',
      amount: b.grandTotal || b.total,
      /// Lowercased to match the admin's BookingStatus union (pending /
      /// confirmed / in_progress / completed / cancelled).
      status: b.status.toLowerCase(),
    })),
  };
};

/// Admin edits a partner's document numbers / images / bank info.
/// Admin-side create — adds a partner row without going through the
/// OTP / onboarding flow. Useful when ops onboards someone in-person
/// (kit handed over, paperwork done, partner ready to take jobs).
///
/// Defaults are biased toward "ready to work":
///   - callVerified: true       (admin met them already)
///   - paymentStatus: 'paid'    (kit fee collected offline)
///   - trainingCompletedAt: now (training happened before this row existed)
///   - isVerified: true         (full activation)
///   - isActive: true
/// Pass `placeInOnboarding: true` to instead route them into the
/// regular onboarding queue (call verified, but admin needs to set
/// fee → pay → train → activate in the queue UI).
///
/// Optional document/bank fields are forwarded into a single
/// PartnerDocument row in the same transaction so the admin doesn't
/// have to navigate to the detail page afterwards.
exports.create = async (payload) => {
  const phone = String(payload.phone).trim();
  const existing = await prisma.partner.findUnique({ where: { phone } });
  if (existing) {
    throw ApiError.conflict('A partner with this phone number already exists');
  }

  const placeInOnboarding = Boolean(payload.placeInOnboarding);
  const cityResolver = require('../geography/city-resolver');
  /// Free-text city is also accepted (mirrors the personal-info
  /// step on the partner app) — resolve to cityId where we can.
  let cityId = payload.cityId ? Number(payload.cityId) : null;
  if (!cityId && payload.city) {
    cityId = await cityResolver.resolve(payload.city);
  }

  const documentFields = [
    'aadharNumber',
    'panNumber',
    'dlNumber',
    'aadharImageUrl',
    'panImageUrl',
    'dlImageUrl',
    'bankAccount',
    'bankIfsc',
    'bankPassbookUrl',
    'signatureUrl',
    'selfieUrl',
  ];
  const doc = {};
  for (const k of documentFields) {
    if (payload[k] != null && payload[k] !== '') doc[k] = payload[k];
  }

  const partnerData = {
    phone,
    name: payload.name?.trim() || null,
    email: payload.email?.trim() || null,
    categoryId: payload.categoryId ? Number(payload.categoryId) : null,
    city: payload.city?.trim() || null,
    cityId,
    /// Activated path vs queued path. The queued path skips marking
    /// payment/training so the partner moves through the existing
    /// onboarding queue starting at the "set fee" step. Either way
    /// callVerified is true because the admin has clearly already
    /// spoken to them — they wouldn't be creating the row otherwise.
    callVerified: true,
    paymentStatus: placeInOnboarding ? 'unpaid' : 'paid',
    onboardingFeePaidAt: placeInOnboarding ? null : new Date(),
    trainingCompletedAt: placeInOnboarding ? null : new Date(),
    isVerified: placeInOnboarding ? false : true,
    isActive: true,
  };

  const created = await prisma.partner.create({
    data: {
      ...partnerData,
      ...(Object.keys(doc).length > 0
        ? { document: { create: doc } }
        : {}),
    },
    include: {
      document: true,
      cityRef: { select: { name: true, state: { select: { name: true, code: true } } } },
    },
  });

  const categoryById = await categoryMap();
  return enrichPartner(created, categoryById, 0, 0);
};

/// Upserts the PartnerDocument row so this works whether the partner
/// has filled anything in or not. Only fields explicitly present in
/// the payload are touched — partial updates leave other fields
/// untouched, so admin can fix one wrong digit without re-typing
/// every other field.
exports.updateDocuments = async (id, payload) => {
  const partnerId = Number(id);
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner) throw ApiError.notFound('Partner not found');

  const allowed = [
    'aadharNumber',
    'panNumber',
    'dlNumber',
    'aadharImageUrl',
    'panImageUrl',
    'dlImageUrl',
    'bankAccount',
    'bankIfsc',
    'bankPassbookUrl',
    'signatureUrl',
  ];
  const data = {};
  for (const k of allowed) {
    if (payload[k] !== undefined) {
      data[k] = payload[k] === '' ? null : payload[k];
    }
  }
  if (Object.keys(data).length === 0) {
    throw ApiError.badRequest('No fields to update');
  }

  await prisma.partnerDocument.upsert({
    where: { partnerId },
    create: { partnerId, ...data },
    update: data,
  });

  return exports.get(partnerId);
};

exports.updateStatus = async (id, status, reason) => {
  /// Map the admin's verb onto the storage model:
  ///   active     → isActive=true, clear suspendReason / suspendedAt
  ///   paused     → isActive=false, no reason captured (a soft pause
  ///                used by ops; partner may re-enable when ready)
  ///   suspended  → isActive=false, capture the reason + timestamp.
  ///                The partner-app reads these to display a banner
  ///                and lock the duty toggle.
  const data = (() => {
    if (status === 'active') {
      return { isActive: true, suspendReason: null, suspendedAt: null };
    }
    if (status === 'suspended') {
      return {
        isActive: false,
        suspendReason: reason ?? 'Suspended by admin',
        suspendedAt: new Date(),
      };
    }
    /// paused — clear any previous suspend state; this is the
    /// non-blame reason for being offline (e.g. partner on leave)
    return { isActive: false, suspendReason: null, suspendedAt: null };
  })();

  try {
    const before = await prisma.partner.findUnique({
      where: { id: Number(id) },
      select: { isActive: true, suspendReason: true },
    });
    const p = await prisma.partner.update({
      where: { id: Number(id) },
      data,
      include: { document: true, cityRef: { select: { name: true, state: { select: { name: true, code: true } } } } },
    });

    /// Blocking a partner (paused / suspended → isActive=false) must pull
    /// them out of the live dispatch pool RIGHT NOW. The DB flag alone
    /// isn't enough: their Redis presence (geo set + lastseen) lingers for
    /// the sticky TTL, so without this they keep getting job offers after
    /// being blocked. The dispatcher's isActive gate is the belt; this is
    /// the immediate removal. (Reactivating doesn't need a counterpart —
    /// the partner re-registers on their next duty-on / presence ping.)
    if (data.isActive === false) {
      const registry = require('../dispatch/registry');
      try {
        await registry.setOffDuty({ partnerId: p.id, categoryId: p.categoryId ?? null });
        await registry.clearDutyMirror(p.id).catch(() => {});
        await prisma.partner
          .update({ where: { id: p.id }, data: { onDuty: false, dutyState: 'off_duty' }, select: { id: true } })
          .catch(() => {});
      } catch {
        /* best-effort — DB flag + dispatcher gate still block dispatch */
      }
    }

    /// Notify the partner whenever this changes their effective state.
    /// We compare against `before` rather than naively firing on every
    /// admin save — re-saving "suspended" with the same reason shouldn't
    /// spam the bell.
    if (before) {
      const notifications = require('../notifications/notifications.service');
      if (status === 'suspended' && (before.isActive || before.suspendReason !== data.suspendReason)) {
        await notifications.create({
          partnerId: p.id,
          type: 'system',
          title: 'Account suspended',
          body: data.suspendReason,
        });
      } else if (status === 'active' && !before.isActive) {
        await notifications.create({
          partnerId: p.id,
          type: 'system',
          title: 'Account reactivated',
          body: 'Your account is active again. You can go on-duty and start receiving jobs.',
        });
      } else if (status === 'paused' && before.isActive) {
        await notifications.create({
          partnerId: p.id,
          type: 'system',
          title: 'Account paused',
          body: 'Your account has been paused by admin. Reach out to support if this is unexpected.',
        });
      }
    }
    const categoryById = await categoryMap();
    return enrichPartner(p, categoryById);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Partner not found');
    throw err;
  }
};

exports.listOnboarding = async ({ status, search, scope, page = 1, pageSize = 25 } = {}) => {
  const { applyScopeToWhere } = require('../../middlewares/adminScope');
  const where = { isVerified: false };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { city: { contains: search, mode: 'insensitive' } },
    ];
  }
  /// Translate the onboardingStatus() derivation into WHERE clauses so the
  /// status tab filters in the DB — page + total are then correct. (List is
  /// already isVerified:false, so 'approved' can't occur here.) Previously
  /// this filtered the already-paged rows, yielding short/empty pages and a
  /// total that ignored the status filter. Mirrors onboardingStatus():
  ///   rejected  = rejectedReason set OR not active
  ///   in_review = active + no rejection + callVerified
  ///   pending   = active + no rejection + not callVerified
  if (status === 'rejected') {
    where.OR = [...(where.OR ?? []), { rejectedReason: { not: null } }, { isActive: false }];
  } else if (status === 'in_review') {
    where.isActive = true;
    where.rejectedReason = null;
    where.callVerified = true;
  } else if (status === 'pending') {
    where.isActive = true;
    where.rejectedReason = null;
    where.callVerified = false;
  }
  if (scope) applyScopeToWhere(where, scope);

  const [items, total, categoryById] = await Promise.all([
    prisma.partner.findMany({
      where,
      include: {
        document: { select: LIST_DOCUMENT_SELECT },
        cityRef: { select: { name: true, state: { select: { name: true, code: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.partner.count({ where }),
    categoryMap(),
  ]);

  const data = items.map((p) => ({
    id: p.id,
    name: p.name ?? p.businessName ?? 'Unnamed partner',
    phone: p.phone,
    email: p.email ?? '',
    category: categoryName(p, categoryById),
    city: p.cityRef?.name ?? p.city ?? 'Not set',
    cityName: p.cityRef?.name ?? p.city ?? null,
    state: p.cityRef?.state?.name ?? null,
    stateCode: p.cityRef?.state?.code ?? null,
    appliedAt: p.createdAt.toISOString().slice(0, 10),
    documents: documentsForPartner(p),
    status: onboardingStatus(p),
    stages: stagesForPartner(p),
    /// Onboarding-progress fields required by the admin review UI to
    /// know which step section to surface next (call → fee → payment
    /// → training → activate). Without these the UI stalls at fee.
    callVerified: Boolean(p.callVerified),
    onboardingFeeAmount: p.onboardingFeeAmount ?? null,
    onboardingFeeNote: p.onboardingFeeNote ?? null,
    onboardingFeePaidAt: p.onboardingFeePaidAt
      ? p.onboardingFeePaidAt.toISOString()
      : null,
    paymentStatus: p.paymentStatus ?? 'unpaid',
    trainingCompletedAt: p.trainingCompletedAt
      ? p.trainingCompletedAt.toISOString()
      : null,
  }));
  /// NOTE: status filtering ('rejected' | 'in_review' | 'pending') now runs
  /// in the WHERE clause above so the page/total are correct. 'all' (or no
  /// status) returns every onboarding row. No post-fetch filter here.

  return {
    data,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

exports.updateStage = async (id, stage, status, note, adminId = null) => {
  const partnerId = Number(id);
  const admin = adminId
    ? await prisma.admin.findUnique({ where: { id: Number(adminId) }, select: { name: true } })
    : null;
  const updatedBy = admin?.name ?? 'Admin';

  try {
    if (stage === 'call') {
      await prisma.partner.update({
        where: { id: partnerId },
        data: { callVerified: status === 'done', rejectedReason: status === 'failed' ? note ?? 'Call verification failed' : null },
      });
    } else if (stage === 'background') {
      await prisma.partnerDocument.upsert({
        where: { partnerId },
        create: {
          partnerId,
          kycStatus: status === 'done' ? 'verified' : status === 'failed' ? 'rejected' : 'pending',
          kycVerifiedAt: status === 'done' ? new Date() : null,
          kycRejectedAt: status === 'failed' ? new Date() : null,
          kycNote: note,
        },
        update: {
          kycStatus: status === 'done' ? 'verified' : status === 'failed' ? 'rejected' : 'pending',
          kycVerifiedAt: status === 'done' ? new Date() : null,
          kycRejectedAt: status === 'failed' ? new Date() : null,
          kycNote: note,
        },
      });
    } else if (stage === 'payment') {
      await prisma.partner.update({
        where: { id: partnerId },
        data: {
          paymentStatus: status === 'done' ? 'paid' : 'unpaid',
          onboardingFeePaidAt: status === 'done' ? new Date() : null,
        },
      });
    }
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Partner not found');
    throw err;
  }

  const details = await exports.get(partnerId);
  details.stages = details.stages.map((s) => (s.key === stage ? { ...s, updatedBy, note: note ?? s.note } : s));
  return details;
};

exports.approve = async (id) => {
  const partnerId = Number(id);
  const partner = await prisma.partner.findUnique({ where: { id: partnerId }, include: { document: true } });
  if (!partner) throw ApiError.notFound('Partner not found');
  if (!hasRequiredDocuments(partner.document)) throw ApiError.badRequest('All required documents must be verified or skipped before approval.');
  if (!partner.callVerified) throw ApiError.badRequest('Call verification must be completed before approval.');
  if (partner.onboardingFeeAmount == null) throw ApiError.badRequest('Set the onboarding fee before activation.');
  if (partner.paymentStatus !== 'paid') throw ApiError.badRequest('Onboarding payment must be completed before activation.');
  if (partner.trainingCompletedAt == null) throw ApiError.badRequest('Mark training complete before activation.');

  await prisma.partner.update({
    where: { id: partnerId },
    data: { isVerified: true, isActive: true, rejectedReason: null },
  });
  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId,
    type: 'system',
    title: 'Account activated',
    body: 'Your account has been activated. Turn on Duty to start receiving jobs.',
  });
  return exports.get(partnerId);
};

/// Admin sets the onboarding fee for a specific partner. Has to be
/// called AFTER call verification — there's no point quoting an
/// amount to a partner who hasn't been screened. Re-callable at any
/// time before payment if admin needs to adjust; refuses once the
/// partner has paid (re-quoting after payment would be confusing).
exports.setOnboardingFee = async (id, { amount, note }) => {
  const partnerId = Number(id);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw ApiError.badRequest('Amount must be a positive number');
  }
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner) throw ApiError.notFound('Partner not found');
  if (!partner.callVerified) {
    throw ApiError.badRequest('Complete call verification before setting the fee.');
  }
  if (partner.paymentStatus === 'paid') {
    throw ApiError.conflict('This partner has already paid — fee cannot be changed.');
  }
  await prisma.partner.update({
    where: { id: partnerId },
    data: {
      onboardingFeeAmount: Math.round(amount),
      onboardingFeeNote: note ? String(note).trim().slice(0, 500) : null,
    },
  });
  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId,
    type: 'onboarding',
    title: 'Onboarding fee set',
    body: `Admin has set your onboarding fee at ₹${Math.round(amount)}. Open the app to pay and proceed.`,
  });
  return exports.get(partnerId);
};

/// Mark / unmark training complete. Toggle, so admin can correct a
/// mistaken click. Refuses if payment hasn't gone through (training
/// happens after payment in our flow); also refuses if the partner
/// is already activated (use suspend / re-onboard if you need to
/// reset).
exports.setTrainingStatus = async (id, { completed }) => {
  const partnerId = Number(id);
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner) throw ApiError.notFound('Partner not found');
  if (completed && partner.paymentStatus !== 'paid') {
    throw ApiError.badRequest('Partner must complete payment before training can be marked done.');
  }
  if (partner.isVerified) {
    throw ApiError.conflict('Cannot change training status — partner is already activated.');
  }
  await prisma.partner.update({
    where: { id: partnerId },
    data: { trainingCompletedAt: completed ? new Date() : null },
  });
  if (completed && !partner.trainingCompletedAt) {
    const notifications = require('../notifications/notifications.service');
    await notifications.create({
      partnerId,
      type: 'system',
      title: 'Training marked complete',
      body: 'Your training has been marked complete by admin. Activation is the next step.',
    });
  }
  return exports.get(partnerId);
};

exports.skipDlVerification = async (id, reason, adminId = null) => {
  const partnerId = Number(id);
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner) throw ApiError.notFound('Partner not found');

  const admin = adminId
    ? await prisma.admin.findUnique({ where: { id: Number(adminId) }, select: { name: true } })
    : null;
  const note = reason?.trim() || 'Skipped by admin';
  const suffix = admin?.name ? ` (${admin.name})` : '';

  await prisma.partnerDocument.upsert({
    where: { partnerId },
    create: {
      partnerId,
      dlSkippedAt: new Date(),
      dlSkipReason: `${note}${suffix}`,
    },
    update: {
      dlSkippedAt: new Date(),
      dlSkipReason: `${note}${suffix}`,
    },
  });

  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId,
    type: 'kyc',
    title: 'Driving license step skipped',
    body: 'Admin has skipped DL verification for your onboarding. Continue with bank verification.',
  });

  return exports.get(partnerId);
};

/// Admin reassigns a partner's job category. Partners themselves
/// can't change this from the partner-app — moving someone from
/// Plumber to Electrician (etc.) has downstream effects on
/// dispatch, commission % and earnings, so the admin owns the
/// decision. Pass `categoryId: null` to clear the assignment.
exports.updateCategory = async (id, categoryId) => {
  const partnerId = Number(id);
  const partner = await prisma.partner.findUnique({ where: { id: partnerId } });
  if (!partner) throw ApiError.notFound('Partner not found');

  if (categoryId != null) {
    const cat = await prisma.category.findUnique({
      where: { id: Number(categoryId) },
      select: { id: true, active: true },
    });
    if (!cat) throw ApiError.badRequest('Selected category does not exist');
    if (!cat.active) throw ApiError.badRequest('Category is not active');
  }

  await prisma.partner.update({
    where: { id: partnerId },
    data: { categoryId: categoryId == null ? null : Number(categoryId) },
  });
  return exports.get(partnerId);
};

exports.reject = async (id, reason) => {
  const partnerId = Number(id);
  try {
    await prisma.partner.update({
      where: { id: partnerId },
      data: { isActive: false, isVerified: false, rejectedReason: reason ?? 'Rejected by admin' },
    });
    return exports.get(partnerId);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Partner not found');
    throw err;
  }
};
