const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');
const crypto = require('crypto');

/**
 * RBAC roles — persisted in the `roles` table (was an in-memory store).
 *
 * A role carries a permission set ({module}.{action} keys), a `scope`
 * ('global' = all cities, 'city' = restricted to the admin's assigned
 * cities), and a `superAdmin` bypass flag. Admins reference a role via
 * `Admin.roleId`; the legacy `Admin.role` column is kept in sync as a
 * scope cache so the existing adminScope middleware keeps working.
 *
 * Built-ins are seeded idempotently on first use (and existing admins
 * are backfilled by their legacy role) so a fresh DB / migrated DB both
 * end up with the four+1 standard roles and every admin pointing at one.
 */

/// CRUD-per-module permission catalog. Keep in sync with
/// `roles.validator.js` (the Zod enum is the canonical whitelist).
const ALL_PERMISSIONS = [
  // Partners
  'partners.view', 'partners.edit', 'partners.suspend', 'partners.delete', 'partners.approve',
  // Onboarding
  'onboarding.view', 'onboarding.approve', 'onboarding.reject',
  'onboarding.set_fee', 'onboarding.set_training', 'onboarding.activate',
  // Customers
  'customers.view', 'customers.edit', 'customers.suspend',
  // Catalog
  'categories.view', 'categories.create', 'categories.edit', 'categories.delete',
  'services.view', 'services.create', 'services.edit', 'services.delete',
  // Marketing
  'banners.view', 'banners.create', 'banners.edit', 'banners.delete',
  'coupons.view', 'coupons.create', 'coupons.edit', 'coupons.delete',
  // Pricing
  'pricing.view', 'pricing.edit',
  'surge.view', 'surge.create', 'surge.edit', 'surge.delete',
  // Coverage
  'geography.view', 'geography.create', 'geography.edit', 'geography.delete',
  'areas.view', 'areas.create', 'areas.edit', 'areas.delete',
  'demand.view',
  // Bookings
  'bookings.view', 'bookings.edit', 'bookings.dispatch',
  'bookings.refund', 'bookings.delete',
  'timeslots.view', 'timeslots.edit',
  // Payments
  'payments.view', 'payments.approve', 'payments.adjust',
  'payouts.view', 'payouts.approve', 'payouts.mark_paid', 'payouts.reject',
  'commission.view', 'commission.edit',
  // Policy
  'policy.view', 'policy.edit',
  'cancellation.edit', 'refund.edit',
  // Analytics
  'analytics.view',
  // Access
  'admins.view', 'admins.create', 'admins.edit', 'admins.delete',
  'roles.view', 'roles.create', 'roles.edit', 'roles.delete', 'roles.manage',
  'audit.view',
];

/// Access-control permissions — held back from the City Manager role so
/// it mirrors the old CITY_MANAGER behaviour (could do everything EXCEPT
/// manage admins / roles, the only `requireRole('SUPER')` gate).
const ACCESS_PERMISSIONS = ALL_PERMISSIONS.filter(
  (p) => p.startsWith('admins.') || p.startsWith('roles.'),
);
const NON_ACCESS_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !ACCESS_PERMISSIONS.includes(p));

/// Stable ids so backfill + cross-references stay deterministic across
/// restarts and re-seeds.
const BUILTINS = [
  {
    id: 'r-super',
    name: 'Super Admin',
    description: 'Full unrestricted access to every module and action, across all cities.',
    scope: 'global',
    superAdmin: true,
    permissions: [...ALL_PERMISSIONS],
  },
  {
    id: 'r-city-manager',
    name: 'City Manager',
    description: 'Day-to-day operations, scoped to assigned cities. No access control.',
    scope: 'city',
    superAdmin: false,
    permissions: [...NON_ACCESS_PERMISSIONS],
  },
  {
    id: 'r-sub',
    name: 'Sub Admin',
    description: 'Platform-wide operations excluding finance approvals and access control.',
    scope: 'global',
    superAdmin: false,
    permissions: [
      'partners.view', 'partners.edit', 'partners.suspend',
      'onboarding.view', 'onboarding.approve', 'onboarding.set_fee', 'onboarding.set_training', 'onboarding.activate', 'onboarding.reject',
      'customers.view', 'customers.edit',
      'categories.view', 'categories.create', 'categories.edit',
      'services.view', 'services.create', 'services.edit',
      'banners.view', 'banners.create', 'banners.edit',
      'coupons.view', 'coupons.create', 'coupons.edit',
      'pricing.view', 'pricing.edit', 'surge.view', 'surge.create', 'surge.edit',
      'geography.view', 'areas.view', 'demand.view',
      'bookings.view', 'bookings.edit', 'bookings.dispatch',
      'timeslots.view', 'timeslots.edit',
      'commission.view',
      'payouts.view', 'payments.view',
      'policy.view',
      'analytics.view',
      'audit.view',
    ],
  },
  {
    id: 'r-support',
    name: 'Support',
    description: 'Read-only access plus dispute and manual-dispatch tools.',
    scope: 'global',
    superAdmin: false,
    permissions: [
      'partners.view', 'customers.view',
      'onboarding.view',
      'bookings.view', 'bookings.dispatch', 'bookings.refund',
      'payouts.view', 'payments.view',
      'analytics.view',
    ],
  },
  {
    id: 'r-fin',
    name: 'Finance',
    description: 'Manages payouts, refunds and ledger reconciliation, platform-wide.',
    scope: 'global',
    superAdmin: false,
    permissions: [
      'bookings.view', 'bookings.refund',
      'payments.view', 'payments.adjust',
      'payouts.view', 'payouts.approve', 'payouts.mark_paid', 'payouts.reject',
      'commission.view', 'commission.edit',
      'analytics.view',
      'audit.view',
    ],
  },
];

/// Seed built-ins + backfill admins, exactly once per process. We
/// create-only (never overwrite an existing row) so admin edits to a
/// built-in's permission set survive restarts. Backfill maps each
/// not-yet-assigned admin to a role by its legacy scope column.
let seedPromise = null;
const ensureSeeded = () => {
  if (!seedPromise) {
    seedPromise = (async () => {
      for (const b of BUILTINS) {
        await prisma.role.upsert({
          where: { id: b.id },
          create: { ...b, builtin: true },
          update: {}, // preserve any admin edits to permissions
        });
      }
      /// Backfill admins missing a roleId from their legacy scope.
      await prisma.admin.updateMany({
        where: { roleId: null, role: 'SUPER' },
        data: { roleId: 'r-super' },
      });
      await prisma.admin.updateMany({
        where: { roleId: null, role: { not: 'SUPER' } },
        data: { roleId: 'r-city-manager' },
      });
    })().catch((err) => {
      /// Reset so a transient failure (e.g. table not migrated yet) can
      /// retry on the next call instead of poisoning the process.
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
};

exports.ensureSeeded = ensureSeeded;
exports.ALL_PERMISSIONS = ALL_PERMISSIONS;

/// Resolve an admin's effective access from their assigned role (or a
/// legacy fallback when no role is attached yet). Returns the scope the
/// JWT/adminScope expects ('SUPER'|'CITY_MANAGER'), the all-bypass flag,
/// and the concrete permission list. `admin` should be loaded WITH its
/// `roleRef` relation. Pure (no DB) so auth can call it freely.
exports.resolveAccess = (admin) => {
  const role = admin?.roleRef;
  if (role) {
    return {
      scope: role.scope === 'global' ? 'SUPER' : 'CITY_MANAGER',
      isSuper: !!role.superAdmin,
      permissions: role.superAdmin ? [...ALL_PERMISSIONS] : (role.permissions ?? []),
      roleId: role.id,
      roleName: role.name,
    };
  }
  /// No role row (pre-backfill, or role deleted) — fall back to the
  /// legacy scope column so access is never accidentally revoked.
  if ((admin?.role || 'SUPER') === 'SUPER') {
    return { scope: 'SUPER', isSuper: true, permissions: [...ALL_PERMISSIONS], roleId: null, roleName: 'Super Admin' };
  }
  return {
    scope: 'CITY_MANAGER',
    isSuper: false,
    permissions: [...NON_ACCESS_PERMISSIONS],
    roleId: null,
    roleName: 'City Manager',
  };
};

const shape = (r, membersById) => ({
  id: r.id,
  name: r.name,
  description: r.description ?? '',
  members: membersById?.get(r.id) ?? 0,
  permissions: r.permissions ?? [],
  scope: r.scope,
  superAdmin: r.superAdmin,
  builtin: r.builtin,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

exports.list = async () => {
  await ensureSeeded();
  const [roles, grouped] = await Promise.all([
    prisma.role.findMany({ orderBy: [{ builtin: 'desc' }, { createdAt: 'asc' }] }),
    prisma.admin.groupBy({ by: ['roleId'], _count: { _all: true } }),
  ]);
  const membersById = new Map(grouped.filter((g) => g.roleId).map((g) => [g.roleId, g._count._all]));
  return roles.map((r) => shape(r, membersById));
};

/// Single-role lookup used by the auth layer to resolve an admin's
/// effective permissions + scope at login / token-decode time.
exports.getById = async (id) => {
  if (!id) return null;
  return prisma.role.findUnique({ where: { id } });
};

exports.create = async (input) => {
  await ensureSeeded();
  const existing = await prisma.role.findUnique({ where: { name: input.name } });
  if (existing) throw ApiError.conflict('A role with this name already exists');
  const role = await prisma.role.create({
    data: {
      id: 'r-' + crypto.randomBytes(4).toString('hex'),
      name: input.name,
      description: input.description ?? '',
      permissions: input.permissions ?? [],
      /// Custom roles are city-scoped by default (the safe, least-
      /// privilege option); a SUPER admin can broaden via the model.
      scope: input.scope === 'global' ? 'global' : 'city',
      superAdmin: false,
      builtin: false,
    },
  });
  return shape(role);
};

exports.update = async (id, input) => {
  await ensureSeeded();
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw ApiError.notFound('Role not found');
  if (role.builtin && input.name && input.name !== role.name) {
    throw ApiError.badRequest('Built-in role name cannot be changed');
  }
  if (input.name && input.name !== role.name) {
    const clash = await prisma.role.findUnique({ where: { name: input.name } });
    if (clash) throw ApiError.conflict('A role with this name already exists');
  }
  const data = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.permissions !== undefined) data.permissions = input.permissions;
  /// `scope`/`superAdmin` are intentionally NOT editable for built-ins;
  /// for custom roles, scope can be adjusted but the bypass flag can't
  /// be granted through the API.
  if (input.scope !== undefined && !role.builtin) {
    data.scope = input.scope === 'global' ? 'global' : 'city';
  }
  const updated = await prisma.role.update({ where: { id }, data });
  return shape(updated);
};

exports.remove = async (id) => {
  await ensureSeeded();
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw ApiError.notFound('Role not found');
  if (role.builtin) throw ApiError.badRequest('Built-in roles cannot be deleted');
  /// Admins on this role fall back to scope-only access (FK is
  /// SetNull). Block deletion while members exist so an admin can
  /// reassign them first rather than silently dropping their authority.
  const members = await prisma.admin.count({ where: { roleId: id } });
  if (members > 0) {
    throw ApiError.badRequest(
      `${members} admin${members === 1 ? '' : 's'} still use this role. Reassign them first.`,
    );
  }
  await prisma.role.delete({ where: { id } });
  return { id };
};
