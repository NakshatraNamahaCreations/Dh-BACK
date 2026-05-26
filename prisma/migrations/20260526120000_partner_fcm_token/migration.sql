-- Direct Firebase Cloud Messaging device token, used for instant
-- job-alert delivery to killed apps on aggressive Android OEMs. Backend
-- prefers this over the legacy Expo push token when both are set.
ALTER TABLE "partners" ADD COLUMN "fcmToken" TEXT;
