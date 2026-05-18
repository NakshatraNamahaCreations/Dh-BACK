const prisma = require('../config/prisma');
const auditLogs = require('../modules/audit-logs/audit-logs.service');

const shouldSkip = (req) => {
  const path = req.originalUrl || req.url || '';
  if (!path.startsWith('/api/v1')) return true;
  if (path.startsWith('/api/v1/health')) return true;
  if (path.startsWith('/api/v1/audit-logs')) return true;
  if (path.startsWith('/api/v1/auth/admin/login')) return true;
  return false;
};

const adminAudit = (req, res, next) => {
  res.on('finish', () => {
    if (shouldSkip(req)) return;
    if (req.user?.type !== 'ADMIN') return;

    setImmediate(async () => {
      try {
        const adminId = Number(req.user.sub);
        const admin = Number.isFinite(adminId)
          ? await prisma.admin.findUnique({
            where: { id: adminId },
            select: { id: true, name: true, email: true },
          })
          : null;

        await auditLogs.write({
          adminId: admin?.id ?? adminId,
          adminName: admin?.name,
          adminEmail: admin?.email,
          module: auditLogs.moduleFromPath(req.originalUrl),
          action: auditLogs.actionFromRequest(req),
          method: req.method,
          path: req.originalUrl,
          targetId: auditLogs.targetFromPath(req.originalUrl),
          statusCode: res.statusCode,
          ip: req.ip,
          userAgent: req.get('user-agent'),
          metadata: {
            params: req.params,
            query: req.query,
            body: req.body,
          },
        });
      } catch (err) {
        // Audit logging must never break the admin workflow.
        console.error('Failed to write admin audit log:', err.message);
      }
    });
  });

  next();
};

module.exports = adminAudit;
