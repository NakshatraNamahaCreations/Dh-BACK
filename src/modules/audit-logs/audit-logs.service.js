const prisma = require('../../config/prisma');

const SENSITIVE_KEYS = new Set(['password', 'token', 'authorization', 'secret', 'accessKey', 'secretKey']);

const scrub = (value) => {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const lower = key.toLowerCase();
      if ([...SENSITIVE_KEYS].some((s) => lower.includes(s.toLowerCase()))) {
        return [key, '[redacted]'];
      }
      return [key, scrub(entry)];
    }),
  );
};

const moduleFromPath = (path) => {
  const clean = String(path || '').split('?')[0].replace(/^\/api\/v1\/?/, '');
  const [module = 'unknown'] = clean.split('/').filter(Boolean);
  return module;
};

const targetFromPath = (path) => {
  const parts = String(path || '').split('?')[0].split('/').filter(Boolean);
  const ignored = new Set(['api', 'v1', 'admin', 'me', 'live', 'stuck', 'disputes']);
  return parts.find((part) => !ignored.has(part) && /^\d+$/.test(part)) ?? null;
};

const actionFromRequest = (req) => {
  const path = req.originalUrl || req.url || '';
  const last = path.split('?')[0].split('/').filter(Boolean).at(-1) ?? '';

  if (last === 'toggle') return 'TOGGLE';
  if (last === 'reorder') return 'REORDER';
  if (last === 'dispatch') return 'ASSIGN_PARTNER';
  if (last === 'cancel') return 'CANCEL';
  if (last === 'approve') return 'APPROVE';
  if (last === 'reject') return 'REJECT';
  if (last === 'resolve') return 'RESOLVE';
  if (last === 'hold') return 'HOLD';
  if (last === 'process') return 'PROCESS';
  if (last === 'bulk' || last === 'bulk-approve') return 'BULK_ACTION';

  const methodAction = {
    GET: 'READ',
    POST: 'CREATE',
    PUT: 'UPDATE',
    PATCH: 'UPDATE',
    DELETE: 'DELETE',
  };
  return methodAction[req.method] ?? req.method;
};

const write = async ({
  adminId,
  adminName,
  adminEmail,
  module,
  action,
  method,
  path,
  targetId,
  statusCode,
  ip,
  userAgent,
  metadata,
}) => {
  await prisma.adminAuditLog.create({
    data: {
      adminId: adminId ?? null,
      adminName: adminName ?? null,
      adminEmail: adminEmail ?? null,
      module,
      action,
      method,
      path,
      targetId: targetId == null ? null : String(targetId),
      statusCode: statusCode ?? null,
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      metadata: metadata == null ? undefined : scrub(metadata),
    },
  });
};

const list = async ({ adminId, module, action, from, to, page = 1, pageSize = 50 } = {}) => {
  const where = {};
  if (adminId) where.adminId = Number(adminId);
  if (module) where.module = module;
  if (action) where.action = action;
  if (from) where.createdAt = { ...(where.createdAt ?? {}), gte: new Date(from) };
  if (to) {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);
    where.createdAt = { ...(where.createdAt ?? {}), lte: toDate };
  }

  const [items, total] = await Promise.all([
    prisma.adminAuditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.adminAuditLog.count({ where }),
  ]);

  return {
    data: items,
    meta: { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
  };
};

module.exports = {
  actionFromRequest,
  list,
  moduleFromPath,
  scrub,
  targetFromPath,
  write,
};
