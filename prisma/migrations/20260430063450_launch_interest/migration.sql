-- CreateTable
CREATE TABLE "launch_interests" (
    "id" SERIAL NOT NULL,
    "phone" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "pincode" TEXT,
    "source" TEXT NOT NULL DEFAULT 'coming_soon',
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launch_interests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "launch_interests_city_createdAt_idx" ON "launch_interests"("city", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "launch_interests_phone_city_key" ON "launch_interests"("phone", "city");
