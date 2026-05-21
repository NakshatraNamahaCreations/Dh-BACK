-- Add Expo push token to customers for broadcast notifications.
ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "expoPushToken" TEXT;

-- Push broadcast campaigns sent by admin.
CREATE TABLE IF NOT EXISTS "push_broadcasts" (
  "id"        SERIAL PRIMARY KEY,
  "title"     TEXT         NOT NULL,
  "body"      TEXT         NOT NULL,
  "imageUrl"  TEXT,
  "audience"  TEXT         NOT NULL,
  "sentBy"    INTEGER      NOT NULL,
  "sentCount" INTEGER      NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "push_broadcasts_createdAt_idx"
  ON "push_broadcasts"("createdAt");
