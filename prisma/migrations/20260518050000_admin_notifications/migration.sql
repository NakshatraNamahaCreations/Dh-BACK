-- CreateTable: admin_notifications
-- Per-admin notification rows. One row per admin per event so mark-as-read
-- by one admin does not affect others.

CREATE TABLE "admin_notifications" (
  "id"         SERIAL PRIMARY KEY,
  "adminId"    INTEGER      NOT NULL,
  "type"       TEXT         NOT NULL,
  "title"      TEXT         NOT NULL,
  "body"       TEXT         NOT NULL,
  "href"       TEXT,
  "bookingId"  INTEGER,
  "partnerId"  INTEGER,
  "customerId" INTEGER,
  "readAt"     TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "admin_notifications"
  ADD CONSTRAINT "admin_notifications_adminId_fkey"
  FOREIGN KEY ("adminId") REFERENCES "admins"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "admin_notifications_adminId_createdAt_idx"
  ON "admin_notifications"("adminId", "createdAt");

CREATE INDEX "admin_notifications_adminId_readAt_idx"
  ON "admin_notifications"("adminId", "readAt");
