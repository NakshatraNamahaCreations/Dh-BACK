-- CreateEnum
CREATE TYPE "DeletionRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable: account_deletion_requests
-- Soft pointer via userType+userId so audit trail survives after the user row is deleted.
CREATE TABLE "account_deletion_requests" (
  "id"          SERIAL PRIMARY KEY,
  "userType"    "UserType"             NOT NULL,
  "userId"      INTEGER                NOT NULL,
  "phone"       TEXT                   NOT NULL,
  "name"        TEXT,
  "email"       TEXT,
  "reason"      TEXT                   NOT NULL,
  "status"      "DeletionRequestStatus" NOT NULL DEFAULT 'PENDING',
  "adminNote"   TEXT,
  "reviewedBy"  INTEGER,
  "reviewedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "account_deletion_requests_status_createdAt_idx"
  ON "account_deletion_requests"("status", "createdAt");

CREATE INDEX "account_deletion_requests_userType_userId_idx"
  ON "account_deletion_requests"("userType", "userId");
