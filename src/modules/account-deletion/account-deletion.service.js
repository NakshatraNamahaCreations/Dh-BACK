const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

const shape = (r) => ({
  id: r.id,
  userType: r.userType,
  userId: r.userId,
  phone: r.phone,
  name: r.name,
  email: r.email,
  reason: r.reason,
  status: r.status,
  adminNote: r.adminNote,
  reviewedBy: r.reviewedBy,
  reviewedAt: r.reviewedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

/// Look up the user record so we can snapshot phone/name/email onto the
/// request — admin needs to see "who" even after the row is deleted.
const loadUserSnapshot = async (userType, userId) => {
  if (userType === 'CUSTOMER') {
    const c = await prisma.customer.findUnique({ where: { id: userId } });
    if (!c) throw ApiError.notFound('Customer not found');
    return { phone: c.phone, name: c.name, email: c.email };
  }
  if (userType === 'PARTNER') {
    const p = await prisma.partner.findUnique({ where: { id: userId } });
    if (!p) throw ApiError.notFound('Partner not found');
    return { phone: p.phone, name: p.name, email: p.email };
  }
  throw ApiError.badRequest('Only customers and partners can request account deletion');
};

/// Customer/partner submits a deletion request. We refuse to create a
/// second PENDING request — they already have one open. Reissuing
/// after an APPROVED row would be impossible anyway (the user row
/// would be gone). REJECTED requests don't block — the user can
/// request again with a different reason.
exports.createRequest = async ({ userType, userId, reason }) => {
  const existingPending = await prisma.accountDeletionRequest.findFirst({
    where: { userType, userId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
  });
  if (existingPending) {
    throw ApiError.conflict(
      'You already have a deletion request pending. Our team will reach out shortly.',
    );
  }

  const snapshot = await loadUserSnapshot(userType, userId);
  const row = await prisma.accountDeletionRequest.create({
    data: {
      userType,
      userId,
      reason,
      ...snapshot,
    },
  });
  return shape(row);
};

/// Current user's latest request (any status). Used by the apps to
/// render "you have a pending request" state on the delete screen
/// without forcing a second screen.
exports.getMine = async ({ userType, userId }) => {
  const row = await prisma.accountDeletionRequest.findFirst({
    where: { userType, userId },
    orderBy: { createdAt: 'desc' },
  });
  return row ? shape(row) : null;
};

const statusToEnum = (s) => {
  if (!s || s === 'all') return undefined;
  return s.toUpperCase();
};

exports.list = async ({ status, userType, search, page = 1, pageSize = 25 } = {}) => {
  const where = {};
  const st = statusToEnum(status);
  if (st) where.status = st;
  if (userType) where.userType = userType;
  if (search) {
    where.OR = [
      { phone: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { reason: { contains: search, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.accountDeletionRequest.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.accountDeletionRequest.count({ where }),
  ]);
  return {
    data: rows.map(shape),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
};

exports.get = async (id) => {
  const row = await prisma.accountDeletionRequest.findUnique({ where: { id: Number(id) } });
  if (!row) throw ApiError.notFound('Deletion request not found');
  return shape(row);
};

/// Anonymise PII fields so the row no longer identifies anyone, free
/// up the unique phone for reuse, and lock the account out. We don't
/// hard-delete the underlying Customer/Partner row because bookings
/// FK back with the default `Restrict` cascade — wiping the user
/// would also wipe history admin needs for ops and reconciliation.
const tombstoneTag = (userType, userId) =>
  `deleted_${userType.toLowerCase()}_${userId}_${Date.now()}`;

/// Admin approves a deletion request: anonymise the underlying user
/// row + flip them inactive (effectively a permanent ban), then mark
/// the request APPROVED. The request itself stays as audit trail.
exports.approve = async (id, { adminId, adminNote } = {}) => {
  const request = await prisma.accountDeletionRequest.findUnique({
    where: { id: Number(id) },
  });
  if (!request) throw ApiError.notFound('Deletion request not found');
  if (request.status !== 'PENDING') {
    throw ApiError.conflict(`Request already ${request.status.toLowerCase()}`);
  }

  await prisma.$transaction(async (tx) => {
    if (request.userType === 'CUSTOMER') {
      const exists = await tx.customer.findUnique({
        where: { id: request.userId },
        select: { id: true },
      });
      if (exists) {
        await tx.customer.update({
          where: { id: request.userId },
          data: {
            phone: tombstoneTag('CUSTOMER', request.userId),
            name: null,
            email: null,
            isActive: false,
          },
        });
      }
    } else if (request.userType === 'PARTNER') {
      const exists = await tx.partner.findUnique({
        where: { id: request.userId },
        select: { id: true },
      });
      if (exists) {
        await tx.partner.update({
          where: { id: request.userId },
          data: {
            phone: tombstoneTag('PARTNER', request.userId),
            name: null,
            email: null,
            businessName: null,
            isActive: false,
            isVerified: false,
            suspendReason: 'Account deleted at user request',
            suspendedAt: new Date(),
          },
        });
        /// PII on the KYC doc is sensitive — wipe identifiers and
        /// image URLs but keep the row for booking-history joins.
        await tx.partnerDocument.updateMany({
          where: { partnerId: request.userId },
          data: {
            aadharNumber: null,
            panNumber: null,
            dlNumber: null,
            bankAccount: null,
            bankIfsc: null,
            aadharImageUrl: null,
            panImageUrl: null,
            dlImageUrl: null,
            bankPassbookUrl: null,
            signatureUrl: null,
            selfieUrl: null,
          },
        });
      }
    }

    await tx.accountDeletionRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        adminNote: adminNote ?? null,
        reviewedBy: adminId ?? null,
        reviewedAt: new Date(),
      },
    });
  });

  const updated = await prisma.accountDeletionRequest.findUnique({
    where: { id: request.id },
  });
  return shape(updated);
};

exports.reject = async (id, { adminId, adminNote }) => {
  const request = await prisma.accountDeletionRequest.findUnique({
    where: { id: Number(id) },
  });
  if (!request) throw ApiError.notFound('Deletion request not found');
  if (request.status !== 'PENDING') {
    throw ApiError.conflict(`Request already ${request.status.toLowerCase()}`);
  }
  const updated = await prisma.accountDeletionRequest.update({
    where: { id: request.id },
    data: {
      status: 'REJECTED',
      adminNote,
      reviewedBy: adminId ?? null,
      reviewedAt: new Date(),
    },
  });
  return shape(updated);
};
