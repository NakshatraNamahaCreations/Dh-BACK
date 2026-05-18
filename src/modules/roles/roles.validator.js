const { z } = require('zod');

const idParam = z.object({
  params: z.object({ id: z.string().min(1) }),
});

/// Permission keys follow `{module}.{action}` so role rows are
/// self-explanatory. Legacy coarse keys (kept for backward compat
/// with rows already in the in-memory store): partners.approve,
/// services.edit, pricing.edit, bookings.dispatch, payments.approve,
/// payments.adjust, policy.edit, roles.manage.
const permission = z.enum([
  // Partners
  'partners.view', 'partners.edit', 'partners.suspend', 'partners.delete',
  'partners.approve',
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
]);

const createSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
    permissions: z.array(permission).default([]),
  }),
});

const updateSchema = z.object({
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      name: z.string().trim().min(1).max(80).optional(),
      description: z.string().trim().max(300).optional(),
      permissions: z.array(permission).optional(),
    })
    .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' }),
});

module.exports = { idParam, createSchema, updateSchema };
