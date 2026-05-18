/* eslint-disable no-console */
/**
 * Backfill cityId on existing rows.
 *
 * Walks Booking, Partner, CustomerAddress, ServiceArea and tries to
 * match each row's free-text `city` to a row in the City table.
 *
 * Match order (cheapest first):
 *   1. exact match on lowercased + trimmed name
 *   2. simple alias map (Bangalore → Bengaluru, Bombay → Mumbai, etc.)
 *
 * Doesn't do Levenshtein / fuzzy by default — most production
 * mismatches are just stale spellings, and aliases handle those
 * cleanly. Pass --fuzzy on the CLI to enable a slow Levenshtein pass
 * for the leftovers (uses a tiny inline implementation; no extra dep).
 *
 * Usage:
 *   npm run backfill:cities             # fast, exact + alias
 *   npm run backfill:cities -- --fuzzy  # also run Levenshtein
 *   npm run backfill:cities -- --apply  # actually write (default is dry-run)
 *
 * The script is dry-run by default so you can review the matches
 * before any writes happen. Re-run with `--apply` to commit.
 */
require('dotenv').config();
const prisma = require('../src/config/prisma');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const FUZZY = args.has('--fuzzy');

/// Cities that admins frequently spell differently. Add more here as
/// the unmatched-list flags them. Keys are lowercased aliases, values
/// are the canonical city name we expect to find in the City table.
const ALIASES = {
  bangalore: 'Bengaluru',
  bangaluru: 'Bengaluru',
  banglore: 'Bengaluru',
  bombay: 'Mumbai',
  calcutta: 'Kolkata',
  madras: 'Chennai',
  gurgaon: 'Gurugram',
  poona: 'Pune',
  trivandrum: 'Thiruvananthapuram',
  cochin: 'Kochi',
  mysore: 'Mysuru',
  mangalore: 'Mangaluru',
  hubli: 'Hubballi',
};

/// Tiny inline Levenshtein for the optional fuzzy pass — keeps us
/// off any extra dependency. Threshold of 2 catches "Bengalurru" /
/// "Bnegaluru" without claiming "Pune" matches "Patna".
const levenshtein = (a, b) => {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
};

const norm = (s) => String(s ?? '').trim().toLowerCase();

/// Build a lookup: lowercased name → cityId. Same name across states
/// is rare in our seed (Hyderabad is the obvious one) — when it
/// happens we pick the FIRST match and log a warning so the admin
/// can manually disambiguate via the UI.
async function buildLookup() {
  const cities = await prisma.city.findMany({
    select: { id: true, name: true, stateId: true, state: { select: { name: true } } },
  });
  const exact = new Map();
  const dups = [];
  for (const c of cities) {
    const key = norm(c.name);
    if (exact.has(key)) {
      dups.push({ key, existing: exact.get(key), incoming: c });
      continue;
    }
    exact.set(key, c);
  }
  if (dups.length) {
    console.log('  Note: same-name cities across states (first match wins):');
    for (const d of dups) {
      console.log(`    "${d.key}" → ${d.existing.state.name} (chosen) vs ${d.incoming.state.name}`);
    }
  }
  return { exact, all: cities };
}

function matchCity(rawCity, lookup) {
  if (!rawCity) return null;
  const key = norm(rawCity);
  if (!key) return null;

  /// 1. exact match
  const direct = lookup.exact.get(key);
  if (direct) return { city: direct, how: 'exact' };

  /// 2. alias map
  const aliased = ALIASES[key];
  if (aliased) {
    const c = lookup.exact.get(norm(aliased));
    if (c) return { city: c, how: `alias:${aliased}` };
  }

  /// 3. fuzzy (opt-in) — distance ≤ 2, only when one clear winner.
  if (FUZZY) {
    let best = null;
    let secondBest = Infinity;
    for (const c of lookup.all) {
      const d = levenshtein(key, norm(c.name));
      if (best == null || d < best.dist) {
        secondBest = best?.dist ?? Infinity;
        best = { city: c, dist: d };
      } else if (d < secondBest) {
        secondBest = d;
      }
    }
    if (best && best.dist <= 2 && secondBest > best.dist) {
      return { city: best.city, how: `fuzzy:dist=${best.dist}` };
    }
  }

  return null;
}

async function backfillTable(tableLabel, fetchRows, applyUpdate, lookup) {
  console.log(`\n• ${tableLabel}`);
  const rows = await fetchRows();
  if (rows.length === 0) {
    console.log('  (no rows with free-text city + null cityId — nothing to do)');
    return { matched: 0, unmatched: 0 };
  }

  let matched = 0;
  let unmatched = 0;
  const unmatchedSamples = new Set();

  for (const row of rows) {
    const m = matchCity(row.city, lookup);
    if (!m) {
      unmatched += 1;
      unmatchedSamples.add(norm(row.city));
      continue;
    }
    matched += 1;
    if (APPLY) {
      await applyUpdate(row.id, m.city.id);
    }
  }

  console.log(`  matched:   ${matched}`);
  console.log(`  unmatched: ${unmatched}`);
  if (unmatchedSamples.size) {
    const samples = [...unmatchedSamples].slice(0, 20).join(', ');
    console.log(`  ↳ unique unmatched values: ${samples}${unmatchedSamples.size > 20 ? ', …' : ''}`);
  }
  return { matched, unmatched };
}

async function main() {
  console.log(APPLY ? '== APPLY MODE: writes will be persisted ==' : '== DRY-RUN: pass --apply to write ==');
  if (FUZZY) console.log('Fuzzy match (Levenshtein ≤ 2) enabled.');

  console.log('\nBuilding city lookup…');
  const lookup = await buildLookup();
  console.log(`  ${lookup.all.length} cities loaded.`);

  if (lookup.all.length === 0) {
    console.error('\nNo cities found. Run `npm run seed:geography` first.');
    process.exit(1);
  }

  let totalMatched = 0;
  let totalUnmatched = 0;

  // Bookings
  const r1 = await backfillTable(
    'bookings',
    () =>
      prisma.booking.findMany({
        where: { cityId: null, city: { not: '' } },
        select: { id: true, city: true },
      }),
    (id, cityId) => prisma.booking.update({ where: { id }, data: { cityId } }),
    lookup,
  );
  totalMatched += r1.matched;
  totalUnmatched += r1.unmatched;

  // Partners
  const r2 = await backfillTable(
    'partners',
    () =>
      prisma.partner.findMany({
        where: { cityId: null, NOT: { city: null } },
        select: { id: true, city: true },
      }),
    (id, cityId) => prisma.partner.update({ where: { id }, data: { cityId } }),
    lookup,
  );
  totalMatched += r2.matched;
  totalUnmatched += r2.unmatched;

  // Customer addresses
  const r3 = await backfillTable(
    'customer_addresses',
    () =>
      prisma.customerAddress.findMany({
        where: { cityId: null, city: { not: '' } },
        select: { id: true, city: true },
      }),
    (id, cityId) => prisma.customerAddress.update({ where: { id }, data: { cityId } }),
    lookup,
  );
  totalMatched += r3.matched;
  totalUnmatched += r3.unmatched;

  // Service areas
  const r4 = await backfillTable(
    'service_areas',
    () =>
      prisma.serviceArea.findMany({
        where: { cityId: null, city: { not: '' } },
        select: { id: true, city: true },
      }),
    (id, cityId) => prisma.serviceArea.update({ where: { id }, data: { cityId } }),
    lookup,
  );
  totalMatched += r4.matched;
  totalUnmatched += r4.unmatched;

  console.log('\n== Summary ==');
  console.log(`  total matched:   ${totalMatched}`);
  console.log(`  total unmatched: ${totalUnmatched}`);
  if (!APPLY && totalMatched > 0) {
    console.log('\nDry-run complete. Re-run with --apply to commit.');
  }
  if (totalUnmatched > 0) {
    console.log('\nUnmatched rows still have free-text city only. Either:');
    console.log('  • add the missing cities via the admin Geography page, then re-run');
    console.log('  • or add an alias to scripts/backfill-cities.js for misspellings');
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
