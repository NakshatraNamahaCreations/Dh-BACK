/**
 * Admin management — CRUD for the Admin table itself. Only SUPER
 * admins are allowed to hit these endpoints (enforced at the route
 * layer via `requireRole('SUPER')`).
 *
 * The flow:
 *   - SUPER creates a CITY_MANAGER (email + password + role)
 *   - SUPER assigns one or more cities to the CITY_MANAGER
 *   - CITY_MANAGER logs in; their JWT carries `role` + `cityIds`,
 *     which every list endpoint intersects into its WHERE clause.
 *
 * Soft-delete via `isActive=false`. We never hard-delete an admin
 * row because their adminId may be referenced from audit logs and
 * AdminCityAssignment (cascade-deleted, but the audit logs are kept
 * via the SetNull relation policy).
 */
const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const { hashPassword, comparePassword } = require('../../utils/password');

const ROLES = ['SUPER', 'CITY_MANAGER'];

const adminShape = (a) => ({
  id: a.id,
  email: a.email,
  name: a.name ?? null,
  role: a.role || 'SUPER',
  isActive: a.isActive,
  cities: (a.cityAssignments ?? []).map((c) => ({
    id: c.city.id,
    name: c.city.name,
    stateId: c.city.stateId,
  })),
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

exports.list = async ({ search, role, status, page = 1, pageSize = 50 } = {}) => {
  const where = {};
  if (role && ROLES.includes(role)) where.role = role;
  if (status === 'active') where.isActive = true;
  else if (status === 'inactive') where.isActive = false;
  if (search) {
    const s = String(search).trim();
    where.OR = [
      { name: { contains: s, mode: 'insensitive' } },
      { email: { contains: s, mode: 'insensitive' } },
    ];
  }
  const [items, total] = await Promise.all([
    prisma.admin.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        cityAssignments: {
          include: { city: { select: { id: true, name: true, stateId: true } } },
        },
      },
    }),
    prisma.admin.count({ where }),
  ]);
  return {
    data: items.map(adminShape),
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

exports.get = async (id) => {
  const a = await prisma.admin.findUnique({
    where: { id: Number(id) },
    include: {
      cityAssignments: {
        include: { city: { select: { id: true, name: true, stateId: true } } },
      },
    },
  });
  if (!a) throw ApiError.notFound('Admin not found');
  return adminShape(a);
};

exports.create = async ({ email, password, name, role, cityIds }) => {
  if (!ROLES.includes(role)) throw ApiError.badRequest('Invalid role');
  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) throw ApiError.conflict('An admin with this email already exists');
  const hashed = await hashPassword(password);
  const data = {
    email,
    password: hashed,
    name: name || null,
    role,
    isActive: true,
  };
  if (role === 'CITY_MANAGER' && Array.isArray(cityIds) && cityIds.length > 0) {
    /// Validate the city IDs up-front — `createMany` would fail with
    /// a foreign-key error otherwise and the rollback would leave us
    /// in an awkward state where the admin was created but with no
    /// cities. Better to fail fast before any writes.
    const found = await prisma.city.findMany({
      where: { id: { in: cityIds.map(Number) } },
      select: { id: true },
    });
    if (found.length !== cityIds.length) {
      throw ApiError.badRequest('One or more cityIds do not exist');
    }
    data.cityAssignments = {
      create: cityIds.map((cityId) => ({ cityId: Number(cityId) })),
    };
  }
  const created = await prisma.admin.create({
    data,
    include: {
      cityAssignments: {
        include: { city: { select: { id: true, name: true, stateId: true } } },
      },
    },
  });
  return adminShape(created);
};

exports.update = async (id, { name, role, isActive }) => {
  const partial = {};
  if (name !== undefined) partial.name = name || null;
  if (role !== undefined) {
    if (!ROLES.includes(role)) throw ApiError.badRequest('Invalid role');
    partial.role = role;
  }
  if (isActive !== undefined) partial.isActive = Boolean(isActive);
  if (Object.keys(partial).length === 0) {
    throw ApiError.badRequest('No fields to update');
  }
  try {
    const updated = await prisma.admin.update({
      where: { id: Number(id) },
      data: partial,
      include: {
        cityAssignments: {
          include: { city: { select: { id: true, name: true, stateId: true } } },
        },
      },
    });
    return adminShape(updated);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Admin not found');
    throw err;
  }
};

/// Replace the admin's full city-assignment set. Diff against the
/// current set so we only insert / delete what actually changed.
exports.setCities = async (id, cityIds) => {
  const adminId = Number(id);
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin) throw ApiError.notFound('Admin not found');
  const requested = new Set((cityIds || []).map(Number));

  if (requested.size > 0) {
    const found = await prisma.city.findMany({
      where: { id: { in: [...requested] } },
      select: { id: true },
    });
    if (found.length !== requested.size) {
      throw ApiError.badRequest('One or more cityIds do not exist');
    }
  }

  await prisma.$transaction(async (tx) => {
    const existing = await tx.adminCityAssignment.findMany({
      where: { adminId },
      select: { cityId: true },
    });
    const current = new Set(existing.map((e) => e.cityId));

    const toRemove = [...current].filter((c) => !requested.has(c));
    const toAdd = [...requested].filter((c) => !current.has(c));

    if (toRemove.length > 0) {
      await tx.adminCityAssignment.deleteMany({
        where: { adminId, cityId: { in: toRemove } },
      });
    }
    if (toAdd.length > 0) {
      await tx.adminCityAssignment.createMany({
        data: toAdd.map((cityId) => ({ adminId, cityId })),
      });
    }
  });

  return exports.get(adminId);
};

exports.resetPassword = async (id, newPassword) => {
  const hashed = await hashPassword(newPassword);
  try {
    await prisma.admin.update({
      where: { id: Number(id) },
      data: { password: hashed },
    });
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Admin not found');
    throw err;
  }
  return { ok: true };
};

/// Self-service password change. Used by both SUPER and CITY_MANAGER
/// admins from the Topbar "Change password" dropdown in the admin
/// panel. Unlike `resetPassword` (which is a privileged override
/// where one admin sets another's password), this requires the
/// caller to prove they know the existing password first.
exports.changeOwnPassword = async (adminId, currentPassword, newPassword) => {
  const admin = await prisma.admin.findUnique({
    where: { id: Number(adminId) },
    select: { id: true, password: true, isActive: true },
  });
  if (!admin) throw ApiError.notFound('Admin not found');
  /// Defensive — if a deactivated admin somehow holds a still-valid
  /// JWT, don't let them rotate their password into a usable account.
  if (!admin.isActive) {
    throw ApiError.forbidden('Account is deactivated. Contact a Super Admin.');
  }

  const ok = await comparePassword(currentPassword, admin.password);
  if (!ok) {
    throw ApiError.badRequest('Current password is incorrect');
  }

  /// Reject a no-op rotation. Re-saving the same password isn't
  /// dangerous, but surfacing the no-op as an explicit error stops
  /// the customer from thinking the change "didn't save" when in
  /// fact nothing changed.
  const sameAsCurrent = await comparePassword(newPassword, admin.password);
  if (sameAsCurrent) {
    throw ApiError.badRequest('New password must differ from the current password');
  }

  const hashed = await hashPassword(newPassword);
  await prisma.admin.update({
    where: { id: admin.id },
    data: { password: hashed },
  });
  return { ok: true };
};
