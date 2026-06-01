-- Direct Firebase Cloud Messaging device token for customers, mirroring
-- partners.fcmToken. Backend prefers this over the legacy Expo push token
-- when both are set.
ALTER TABLE "customers" ADD COLUMN "fcmToken" TEXT;
