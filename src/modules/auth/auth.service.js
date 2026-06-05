const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const { signToken } = require('../../utils/jwt');
const { comparePassword } = require('../../utils/password');
const otpService = require('./otp.service');
const auditLogs = require('../audit-logs/audit-logs.service');
const rolesService = require('../roles/roles.service');

const stripPassword = ({ password, ...rest }) => rest;

// -------- Customer (OTP) --------

const customerSendOtp = async ({ phone }) => {
  return otpService.requestOtp({ phone, userType: 'CUSTOMER' });
};

const customerVerifyOtp = async ({ phone, code, name }) => {
  await otpService.verifyOtp({ phone, userType: 'CUSTOMER', code });

  let customer = await prisma.customer.findUnique({ where: { phone } });
  if (!customer) {
    customer = await prisma.customer.create({ data: { phone, name } });
  } else if (!customer.isActive) {
    throw ApiError.forbidden('Account is disabled');
  }

  const token = signToken({ sub: customer.id, type: 'CUSTOMER' });
  return { user: customer, token };
};

// -------- Partner (OTP) --------

const partnerSendOtp = async ({ phone }) => {
  return otpService.requestOtp({ phone, userType: 'PARTNER' });
};

const PARTNER_INCLUDE = { document: true };

const partnerVerifyOtp = async ({ phone, code, name }) => {
  await otpService.verifyOtp({ phone, userType: 'PARTNER', code });

  let partner = await prisma.partner.findUnique({ where: { phone }, include: PARTNER_INCLUDE });
  let isFreshSignup = false;
  if (!partner) {
    partner = await prisma.partner.create({ data: { phone, name }, include: PARTNER_INCLUDE });
    isFreshSignup = true;
  } else if (!partner.isActive) {
    throw ApiError.forbidden('Account is disabled');
  }

  /// New partner just walked through OTP → put them in the admin
  /// bell so ops sees them in the "Onboarding review" queue without
  /// waiting for the next page refresh. Soft-fail in the helper, so
  /// a notification hiccup never blocks the partner login flow.
  if (isFreshSignup) {
    try {
      const adminNotifs = require('../notifications/admin-notifications.service');
      void adminNotifs.notifyAllAdmins({
        type: adminNotifs.TYPES.PARTNER_SIGNUP,
        title: `New partner: ${partner.name ?? partner.phone}`,
        body: 'A new partner just signed up. Review their onboarding before they go live.',
        href: '/partners/onboarding',
        partnerId: partner.id,
      });
    } catch { /* notification surface should never block login */ }
  }

  const token = signToken({ sub: partner.id, type: 'PARTNER' });
  return { user: partner, token };
};

// -------- Admin (email + password) --------

const adminLogin = async ({ email, password }) => {
  /// Make sure the built-in roles exist and legacy admins are backfilled
  /// before we resolve access. Non-fatal: if the roles table isn't
  /// migrated yet, `resolveAccess` falls back to the legacy scope column
  /// so login keeps working.
  await rolesService.ensureSeeded().catch(() => {});

  const admin = await prisma.admin.findUnique({
    where: { email },
    include: { cityAssignments: { select: { cityId: true } }, roleRef: true },
  });
  if (!admin || !admin.isActive) throw ApiError.unauthorized('Invalid credentials');

  const ok = await comparePassword(password, admin.password);
  if (!ok) throw ApiError.unauthorized('Invalid credentials');

  /// Bake scope + permissions straight into the JWT so route middlewares
  /// can authorize without an extra DB hop. `super` admins carry the
  /// bypass flag (and an empty `perms` to keep the token small — the
  /// bypass makes the list irrelevant); everyone else carries their
  /// role's concrete permission list. CITY_MANAGER scope with zero
  /// cities is intentional — they see nothing until a SUPER assigns at
  /// least one (locked-out-by-default).
  const cityIds = admin.cityAssignments.map((a) => a.cityId);
  const access = rolesService.resolveAccess(admin);
  const token = signToken({
    sub: admin.id,
    type: 'ADMIN',
    /// Identity, surfaced in the admin-panel topbar so it shows the
    /// actual signed-in admin + their role (not a generic "Admin").
    name: admin.name ?? null,
    email: admin.email,
    roleName: access.roleName,
    role: access.scope,
    cityIds,
    super: access.isSuper,
    perms: access.isSuper ? [] : access.permissions,
  });
  auditLogs.write({
    adminId: admin.id,
    adminName: admin.name,
    adminEmail: admin.email,
    module: 'auth',
    action: 'LOGIN',
    method: 'POST',
    path: '/api/v1/auth/admin/login',
    targetId: admin.id,
    statusCode: 200,
    metadata: { email },
  }).catch((err) => {
    console.error('Failed to write admin login audit log:', err.message);
  });
  return { user: stripPassword(admin), token };
};

// -------- Current user resolver --------

const me = async ({ sub, type }) => {
  if (type === 'CUSTOMER') {
    const user = await prisma.customer.findUnique({ where: { id: sub } });
    if (!user) throw ApiError.notFound('Customer not found');
    return { type, user };
  }
  if (type === 'PARTNER') {
    const user = await prisma.partner.findUnique({ where: { id: sub }, include: PARTNER_INCLUDE });
    if (!user) throw ApiError.notFound('Partner not found');
    /// Resolve the human-readable category name so the partner-app can
    /// display "AC Repair" / "Electrician" etc. on profile screens
    /// without a follow-up fetch. Partner.categoryId has no Prisma
    /// relation defined (legacy schema choice), so we look it up
    /// directly.
    let categoryName = null;
    if (user.categoryId) {
      const cat = await prisma.category.findUnique({
        where: { id: user.categoryId },
        select: { name: true },
      });
      categoryName = cat?.name ?? null;
    }
    return { type, user: { ...user, categoryName } };
  }
  if (type === 'ADMIN') {
    await rolesService.ensureSeeded().catch(() => {});
    const user = await prisma.admin.findUnique({
      where: { id: sub },
      include: {
        cityAssignments: {
          include: { city: { select: { id: true, name: true, stateId: true } } },
        },
        roleRef: true,
      },
    });
    if (!user) throw ApiError.notFound('Admin not found');
    /// Flatten the scope into shapes the admin panel can consume
    /// directly — `cityIds` for filter intersections, `cities` for
    /// the assignment chips on the Admin Users page. `permissions` +
    /// `super` drive the panel's permission-based UI gating; `role`
    /// (scope) is kept for backward compatibility.
    const cities = user.cityAssignments.map((a) => a.city);
    const cityIds = cities.map((c) => c.id);
    const access = rolesService.resolveAccess(user);
    const safe = stripPassword(user);
    delete safe.cityAssignments;
    delete safe.roleRef;
    return {
      type,
      user: {
        ...safe,
        role: access.scope,
        roleId: access.roleId,
        roleName: access.roleName,
        super: access.isSuper,
        permissions: access.isSuper ? rolesService.ALL_PERMISSIONS : access.permissions,
        cityIds,
        cities,
      },
    };
  }
  throw ApiError.unauthorized('Invalid token');
};

const DOCUMENT_FIELDS = [
  'aadharNumber', 'panNumber', 'dlNumber', 'bankAccount', 'bankIfsc',
  'aadharImageUrl', 'aadharBackImageUrl', 'panImageUrl', 'dlImageUrl', 'bankPassbookUrl',
  'selfieUrl',
];

/// Activation gate. Aadhaar (identity) + Bank (payout) are MANDATORY. PAN
/// and DL are skippable — each is satisfied by EITHER a verification OR a
/// skip, so a partner can finish onboarding and complete them later from
/// their profile. (Skipped still counts as incomplete for the profile
/// nudge — that's a separate notion in partner-app/utils/onboarding.ts.)
const hasRequiredPartnerDocuments = (document) =>
  Boolean(
    document?.aadharNumber &&
    (document?.panVerifiedAt || document?.panSkippedAt) &&
    (document?.dlVerifiedAt || document?.dlSkippedAt) &&
    document?.bankAccount &&
    document?.bankIfsc,
  );

const updateMe = async ({ sub, type }, data) => {
  if (type === 'CUSTOMER') {
    const user = await prisma.customer.update({ where: { id: sub }, data });
    return { type, user };
  }
  if (type === 'PARTNER') {
    // Split incoming fields between the Partner row and PartnerDocument row.
    const docData = {};
    const partnerData = {};
    for (const [k, v] of Object.entries(data)) {
      if (DOCUMENT_FIELDS.includes(k)) docData[k] = v;
      else partnerData[k] = v;
    }

    /// Auto-tag the partner with the canonical cityId whenever the
    /// free-text city is set/changed. Lazy-required so a circular
    /// import via geography → resolver doesn't bite. Resolver returns
    /// null cleanly when the city isn't in our table — that's fine,
    /// the partner stays on free-text and the backfill / admin can
    /// patch them up later.
    if (partnerData.city != null) {
      const cityResolver = require('../geography/city-resolver');
      partnerData.cityId = await cityResolver.resolve(partnerData.city);
    }

    if (Object.keys(partnerData).length > 0) {
      await prisma.partner.update({ where: { id: sub }, data: partnerData });
    }
    if (Object.keys(docData).length > 0) {
      await prisma.partnerDocument.upsert({
        where: { partnerId: sub },
        create: { partnerId: sub, ...docData },
        update: docData,
      });
    }

    const user = await prisma.partner.findUnique({ where: { id: sub }, include: PARTNER_INCLUDE });
    return { type, user };
  }
  throw ApiError.forbidden('Profile updates are only available for customers and partners.');
};

// Called after partner completes onboarding payment.
// Replace the body of this function with real payment-gateway verification
// (e.g. verify Razorpay orderId + paymentId) before going to production.
//
// IMPORTANT: payment alone does NOT activate the partner anymore. The
// flow is now: docs → call verified → admin sets fee → partner pays
// (this fn) → admin marks training done → admin activates. Activation
// lives in `partners.approve` (admin endpoint); we only flip the
// payment columns here.
const partnerPaymentDone = async (partnerId) => {
  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    include: PARTNER_INCLUDE,
  });

  if (!partner) throw ApiError.notFound('Partner not found');
  if (partner.paymentStatus === 'paid') {
    /// Idempotency — replayed payment confirmation just returns the
    /// existing row instead of throwing.
    return { type: 'PARTNER', user: partner };
  }
  if (!partner.callVerified) {
    throw ApiError.forbidden('Call verification must be completed before payment.');
  }
  if (!hasRequiredPartnerDocuments(partner.document)) {
    throw ApiError.forbidden('Please complete all document steps before paying.');
  }
  if (partner.onboardingFeeAmount == null) {
    throw ApiError.forbidden('The onboarding fee has not been set by admin yet. Please wait.');
  }

  const updated = await prisma.partner.update({
    where: { id: partnerId },
    data: {
      paymentStatus: 'paid',
      onboardingFeePaidAt: new Date(),
      /// Don't touch isActive / isVerified here — admin still needs
      /// to mark training complete, then activate. Clear the
      /// rejectedReason so a previously-rejected partner who fixed
      /// their issues and re-paid doesn't carry the old reason.
      rejectedReason: null,
    },
    include: PARTNER_INCLUDE,
  });

  const notifications = require('../notifications/notifications.service');
  await notifications.create({
    partnerId: updated.id,
    type: 'payment',
    title: 'Onboarding fee received',
    body: `₹${partner.onboardingFeeAmount} payment received. Admin will mark training complete next.`,
  });

  return { type: 'PARTNER', user: updated };
};

const registerPushToken = async ({ sub, type }, token) => {
  if (!token) return;
  const isExpo = token.startsWith('ExponentPushToken[');
  const data = isExpo ? { expoPushToken: token } : { fcmToken: token };
  if (type === 'CUSTOMER') {
    await prisma.customer.update({ where: { id: sub }, data });
  } else if (type === 'PARTNER') {
    await prisma.partner.update({ where: { id: sub }, data });
  }
};

module.exports = {
  customerSendOtp,
  customerVerifyOtp,
  partnerSendOtp,
  partnerVerifyOtp,
  adminLogin,
  me,
  updateMe,
  partnerPaymentDone,
  registerPushToken,
};
