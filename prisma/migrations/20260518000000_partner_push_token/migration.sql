-- Add expoPushToken column to partners table for background push notifications
ALTER TABLE "partners" ADD COLUMN "expoPushToken" TEXT;
