-- Role: RBAC permission roles assignable to admins.
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT NOT NULL DEFAULT 'city',
    "superAdmin" BOOLEAN NOT NULL DEFAULT false,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- Admin.roleId — nullable FK to roles. SetNull so deleting a role
-- leaves the admin row intact (scope-only access until reassigned).
ALTER TABLE "admins" ADD COLUMN "roleId" TEXT;
ALTER TABLE "admins" ADD CONSTRAINT "admins_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "admins_roleId_idx" ON "admins"("roleId");
