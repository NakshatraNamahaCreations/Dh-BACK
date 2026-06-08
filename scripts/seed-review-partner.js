/**
 * Seed / upgrade the APP-STORE REVIEW partner account.
 *
 * Google's Play Store reviewer logs into the OTP-gated partner app using the
 * review-bypass number (see REVIEW_LOGIN_PHONE / REVIEW_LOGIN_OTP env + the
 * bypass in auth/otp.service.js). For the reviewer to see a WORKING app
 * (Home, not the onboarding flow or "Account disabled"), that number needs a
 * fully-onboarded, ACTIVE partner row.
 *
 * This script upserts that partner: verified + active, with a name, the
 * first active service category, and a city — so stageFromPartner resolves
 * straight to 'active' and the reviewer lands on Home.
 *
 * Run:  node scripts/seed-review-partner.js
 * Phone defaults to REVIEW_LOGIN_PHONE, or pass one:
 *       node scripts/seed-review-partner.js +919999900000
 *
 * Idempotent — safe to re-run. Does NOT touch any real partner.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const phone = process.argv[2] || process.env.REVIEW_LOGIN_PHONE || '+919999900000';

(async () => {
  if (!phone.startsWith('+')) {
    // eslint-disable-next-line no-console
    console.error(
      `Phone "${phone}" should be in full +<country><number> form (e.g. +919999900000) ` +
        'so it matches what the app sends and how partners are stored.',
    );
    process.exit(1);
  }

  const category = await prisma.category.findFirst({
    where: { active: true },
    orderBy: { id: 'asc' },
    select: { id: true, name: true },
  });
  if (!category) {
    // eslint-disable-next-line no-console
    console.error('No active service category found — create one in the admin panel first.');
    process.exit(1);
  }

  /// Everything the activation gate checks, set so the reviewer reaches Home:
  ///   isVerified + isActive  → stageFromPartner returns 'active'
  ///   name + categoryId + city → passes the basic-info gate
  ///   callVerified / fee / training → satisfied so no onboarding holding screen
  const data = {
    name: 'Review Tester',
    categoryId: category.id,
    city: 'Bengaluru',
    callVerified: true,
    onboardingFeeAmount: 0,
    paymentStatus: 'paid',
    trainingCompletedAt: new Date(),
    isVerified: true,
    isActive: true,
    suspendReason: null,
    suspendedAt: null,
    rejectedReason: null,
  };

  const partner = await prisma.partner.upsert({
    where: { phone },
    create: { phone, ...data },
    update: data,
  });

  /// Mark the four KYC documents as verified/skipped so the partner-side
  /// "Documents" screen + any document gate reads as complete. PAN & DL are
  /// skipped (the reviewer doesn't upload real KYC); Aadhaar + Bank get a
  /// placeholder verified state.
  const now = new Date();
  await prisma.partnerDocument.upsert({
    where: { partnerId: partner.id },
    create: {
      partnerId: partner.id,
      aadharNumber: '000000000000',
      aadharVerifiedAt: now,
      panSkippedAt: now,
      panSkipReason: 'Review account',
      dlSkippedAt: now,
      dlSkipReason: 'Review account',
      bankAccount: '0000000000',
      bankIfsc: 'HDFC0000000',
      bankVerifiedAt: now,
    },
    update: {
      aadharNumber: '000000000000',
      aadharVerifiedAt: now,
      panSkippedAt: now,
      panSkipReason: 'Review account',
      dlSkippedAt: now,
      dlSkipReason: 'Review account',
      bankAccount: '0000000000',
      bankIfsc: 'HDFC0000000',
      bankVerifiedAt: now,
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    `✔ Review partner ready: id=${partner.id} phone=${phone} ` +
      `category="${category.name}" verified=true active=true. ` +
      `Reviewer logs in with this number + the REVIEW_LOGIN_OTP and lands on Home.`,
  );
  await prisma.$disconnect();
})().catch(async (e) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
