require('dotenv').config();

const { PrismaClient, Prisma } = require('@prisma/client');
const env = require('../src/config/env');

/// Rewrites stored asset URLs from the raw S3 origin to the CDN base URL.
///
/// The DB stores full absolute URLs (Service.imageUrl, Category.bannerImageUrl,
/// PartnerKyc.*Url, Banner.imageUrl, ...), so pointing S3_PUBLIC_BASE_URL at a
/// CDN only affects NEW uploads. This script migrates the historical rows.
///
/// Usage:
///   node scripts/migrate-image-urls-to-cdn.js --dry-run
///   node scripts/migrate-image-urls-to-cdn.js
///   node scripts/migrate-image-urls-to-cdn.js --from https://old-base --to https://new-base
///
/// Defaults: --from is the raw S3 origin derived from S3_BUCKET/S3_REGION,
///           --to   is S3_PUBLIC_BASE_URL (set it to the CDN first!).
/// Only values that START WITH --from are touched, so deep-link / external
/// URLs in the same columns are never rewritten.

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const stripSlash = (s) => s.replace(/\/+$/, '');

const FROM = stripSlash(
  argValue('--from') || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`,
);
const TO = stripSlash(argValue('--to') || env.S3_PUBLIC_BASE_URL || '');

if (!TO) {
  console.error('No target base URL. Set S3_PUBLIC_BASE_URL in .env or pass --to.');
  process.exit(1);
}
if (FROM === TO) {
  console.error(`--from and --to are both ${FROM} — set S3_PUBLIC_BASE_URL to the CDN first.`);
  process.exit(1);
}

/// Every String column whose name ends in "Url" across the whole schema,
/// discovered from Prisma's DMMF so new models are picked up automatically.
const urlColumns = Prisma.dmmf.datamodel.models.flatMap((model) =>
  model.fields
    .filter((f) => f.kind === 'scalar' && f.type === 'String' && /url$/i.test(f.name))
    .map((f) => ({
      table: model.dbName || model.name,
      column: f.dbName || f.name,
      label: `${model.name}.${f.name}`,
    })),
);

const q = (ident) => `"${ident.replace(/"/g, '""')}"`;

const main = async () => {
  const prisma = new PrismaClient();
  console.log(`${DRY_RUN ? '[dry-run] ' : ''}${FROM}/*  ->  ${TO}/*`);
  console.log(`Scanning ${urlColumns.length} URL columns...\n`);

  let total = 0;
  try {
    for (const { table, column, label } of urlColumns) {
      const like = `${FROM}/%`;
      if (DRY_RUN) {
        const rows = await prisma.$queryRawUnsafe(
          `SELECT COUNT(*)::int AS n FROM ${q(table)} WHERE ${q(column)} LIKE $1`,
          like,
        );
        const n = rows[0]?.n ?? 0;
        if (n > 0) console.log(`  ${label}: ${n} row(s) would be rewritten`);
        total += n;
      } else {
        const n = await prisma.$executeRawUnsafe(
          `UPDATE ${q(table)}
             SET ${q(column)} = $2 || SUBSTRING(${q(column)} FROM ${FROM.length + 1})
           WHERE ${q(column)} LIKE $1`,
          like,
          TO,
        );
        if (n > 0) console.log(`  ${label}: ${n} row(s) rewritten`);
        total += n;
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`\n${DRY_RUN ? 'Would rewrite' : 'Rewrote'} ${total} value(s) total.`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
