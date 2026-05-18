/**
 * One-shot data transfer from local Postgres → Neon for a specific
 * subset of tables: categories, services, service_faqs, app_banners
 * (which covers both HOME_HERO and SPOTLIGHT banner placements).
 *
 * Usage from `backend/`:
 *
 *   # Make sure the Neon schema is in place first
 *   npx prisma migrate deploy
 *
 *   # Then run the transfer
 *   SOURCE_DATABASE_URL="postgresql://postgres:123456@localhost:5432/dhoond" \
 *     node scripts/transfer-to-neon.js
 *
 * On Windows PowerShell:
 *
 *   $env:SOURCE_DATABASE_URL="postgresql://postgres:123456@localhost:5432/dhoond"
 *   node scripts/transfer-to-neon.js
 *
 * Behaviour:
 *   - Reads every row from the four tables on SOURCE in dependency
 *     order (categories → services → service_faqs → app_banners).
 *   - Upserts each row on TARGET by `id`, so re-running the script is
 *     idempotent (existing rows update, new rows insert).
 *   - Resets each table's id-sequence on TARGET to MAX(id) so future
 *     auto-increment inserts from the admin panel don't collide with
 *     the migrated rows.
 *   - Leaves all other tables untouched.
 *
 * No data is deleted from either side. Run a second time if you add
 * more categories / services locally; the script picks up new rows
 * and refreshes any rows that changed.
 */

const { PrismaClient } = require('@prisma/client');

const SOURCE_URL =
  process.env.SOURCE_DATABASE_URL ||
  'postgresql://postgres:123456@localhost:5432/dhoond';

const TARGET_URL = process.env.DATABASE_URL;
if (!TARGET_URL) {
  console.error('❌ DATABASE_URL is not set — point this at the Neon URL via .env');
  process.exit(1);
}
if (TARGET_URL === SOURCE_URL) {
  console.error('❌ SOURCE_DATABASE_URL and DATABASE_URL are the same. Aborting to prevent a self-copy.');
  process.exit(1);
}

const source = new PrismaClient({ datasourceUrl: SOURCE_URL });
const target = new PrismaClient({ datasourceUrl: TARGET_URL });

/// Sequence name follows Postgres's default for `@id @default(autoincrement())`
/// columns: `<table>_id_seq`. Keep the map in sync with `@@map` in
/// schema.prisma — these are the snake_cased table names.
const SEQUENCES = {
  categories: 'categories_id_seq',
  services: 'services_id_seq',
  service_faqs: 'service_faqs_id_seq',
  app_banners: 'app_banners_id_seq',
};

const resetSequence = async (tableName) => {
  const seq = SEQUENCES[tableName];
  if (!seq) return;
  await target.$executeRawUnsafe(
    `SELECT setval('${seq}', (SELECT COALESCE(MAX(id), 1) FROM "${tableName}"))`,
  );
};

/// Copy every row from one Prisma model to another using upsert so the
/// script is rerun-safe. `model` is the Prisma client property name
/// (camelCase); `tableName` is the underlying SQL table for the
/// sequence reset.
const copyModel = async (model, tableName, label) => {
  const rows = await source[model].findMany();
  console.log(`→ ${label}: ${rows.length} row${rows.length === 1 ? '' : 's'}`);

  let inserted = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await target[model].findUnique({ where: { id: row.id } });
    await target[model].upsert({
      where: { id: row.id },
      create: row,
      update: row,
    });
    if (existing) updated += 1;
    else inserted += 1;
  }

  await resetSequence(tableName);
  console.log(`  ✓ ${label}: ${inserted} inserted, ${updated} updated, sequence reset`);
};

(async () => {
  console.log('Source :', SOURCE_URL.replace(/:[^:]+@/, ':***@'));
  console.log('Target :', TARGET_URL.replace(/:[^:]+@/, ':***@'));
  console.log('');

  try {
    /// Dependency order matters here:
    ///   • service has FK → category
    ///   • serviceFaq has FK → service
    /// app_banner has no FK constraints, but we put it last so the
    /// admin's ctaValue references (which are stringified category /
    /// service IDs) resolve correctly when the customer-app reads
    /// the banner.
    await copyModel('category', 'categories', 'Categories');
    await copyModel('service', 'services', 'Services');
    await copyModel('serviceFaq', 'service_faqs', 'Service FAQs');
    await copyModel('appBanner', 'app_banners', 'App banners (incl. SPOTLIGHT)');

    console.log('\nTransfer complete.');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Transfer failed:', err.message);
    if (err.code) console.error('   Prisma code:', err.code);
    if (err.meta) console.error('   Meta:', err.meta);
    process.exit(1);
  } finally {
    await source.$disconnect();
    await target.$disconnect();
  }
})();
