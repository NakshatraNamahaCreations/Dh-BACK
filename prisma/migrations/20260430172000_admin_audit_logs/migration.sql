CREATE TABLE "admin_audit_logs" (
    "id" SERIAL NOT NULL,
    "adminId" INTEGER,
    "adminName" TEXT,
    "adminEmail" TEXT,
    "module" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "targetId" TEXT,
    "statusCode" INTEGER,
    "ip" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_adminId_createdAt_idx" ON "admin_audit_logs"("adminId", "createdAt");
CREATE INDEX "admin_audit_logs_module_createdAt_idx" ON "admin_audit_logs"("module", "createdAt");
CREATE INDEX "admin_audit_logs_action_createdAt_idx" ON "admin_audit_logs"("action", "createdAt");

ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "admins"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
