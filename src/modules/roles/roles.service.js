// In-memory roles store. Move to a Role table when ready.
const ApiError = require('../../utils/ApiError');
const crypto = require('crypto');

/// CRUD-per-module permission catalog. Keep in sync with
/// `roles.validator.js` (the Zod enum is the canonical whitelist).
/// Legacy coarse keys are intentionally still here so role rows
/// created before the CRUD split keep validating.
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

let roles = [
  {
    id: 'r-super',
    name: 'Super Admin',
    description: 'Full unrestricted access to every module and action.',
    members: 2,
    permissions: [...ALL_PERMISSIONS],
    builtin: true,
  },
  {
    id: 'r-sub',
    name: 'Sub Admin',
    description: 'Day-to-day operations excluding finance approvals and access control.',
    members: 4,
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
    builtin: true,
  },
  {
    id: 'r-support',
    name: 'Support',
    description: 'Read-only access plus dispute and manual-dispatch tools.',
    members: 9,
    permissions: [
      'partners.view', 'customers.view',
      'onboarding.view',
      'bookings.view', 'bookings.dispatch', 'bookings.refund',
      'payouts.view', 'payments.view',
      'analytics.view',
    ],
    builtin: true,
  },
  {
    id: 'r-fin',
    name: 'Finance',
    description: 'Manages payouts, refunds and ledger reconciliation.',
    members: 3,
    permissions: [
      'bookings.view', 'bookings.refund',
      'payments.view', 'payments.adjust',
      'payouts.view', 'payouts.approve', 'payouts.mark_paid', 'payouts.reject',
      'commission.view', 'commission.edit',
      'analytics.view',
      'audit.view',
    ],
    builtin: true,
  },
];

exports.list = async () => roles;

exports.create = async (input) => {
  const role = {
    id: 'r-' + crypto.randomBytes(4).toString('hex'),
    name: input.name,
    description: input.description ?? '',
    members: 0,
    permissions: input.permissions,
    builtin: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  roles = [...roles, role];
  return role;
};

exports.update = async (id, input) => {
  const idx = roles.findIndex((r) => r.id === id);
  if (idx === -1) throw ApiError.notFound('Role not found');
  if (roles[idx].builtin && input.name && input.name !== roles[idx].name) {
    throw ApiError.badRequest('Built-in role name cannot be changed');
  }
  roles[idx] = {
    ...roles[idx],
    ...input,
    updatedAt: new Date().toISOString(),
  };
  return roles[idx];
};

exports.remove = async (id) => {
  const idx = roles.findIndex((r) => r.id === id);
  if (idx === -1) throw ApiError.notFound('Role not found');
  if (roles[idx].builtin) throw ApiError.badRequest('Built-in roles cannot be deleted');
  roles = roles.filter((r) => r.id !== id);
  return { id };
};
