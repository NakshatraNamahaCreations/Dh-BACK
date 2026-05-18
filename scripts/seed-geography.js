/* eslint-disable no-console */
/**
 * Geography seed — 28 Indian states + 8 UTs and a starter set of
 * cities Dhoond is most likely to operate in. Idempotent: running
 * twice is safe (uses upsert by name).
 *
 * Usage:
 *   npm run seed:geography
 */
require('dotenv').config();
const prisma = require('../src/config/prisma');

/// ISO 3166-2:IN — every Indian state and union territory with the
/// short code admins know from CSVs and PAN/GST forms.
const STATES = [
  { name: 'Andhra Pradesh', code: 'AP' },
  { name: 'Arunachal Pradesh', code: 'AR' },
  { name: 'Assam', code: 'AS' },
  { name: 'Bihar', code: 'BR' },
  { name: 'Chhattisgarh', code: 'CG' },
  { name: 'Goa', code: 'GA' },
  { name: 'Gujarat', code: 'GJ' },
  { name: 'Haryana', code: 'HR' },
  { name: 'Himachal Pradesh', code: 'HP' },
  { name: 'Jharkhand', code: 'JH' },
  { name: 'Karnataka', code: 'KA' },
  { name: 'Kerala', code: 'KL' },
  { name: 'Madhya Pradesh', code: 'MP' },
  { name: 'Maharashtra', code: 'MH' },
  { name: 'Manipur', code: 'MN' },
  { name: 'Meghalaya', code: 'ML' },
  { name: 'Mizoram', code: 'MZ' },
  { name: 'Nagaland', code: 'NL' },
  { name: 'Odisha', code: 'OD' },
  { name: 'Punjab', code: 'PB' },
  { name: 'Rajasthan', code: 'RJ' },
  { name: 'Sikkim', code: 'SK' },
  { name: 'Tamil Nadu', code: 'TN' },
  { name: 'Telangana', code: 'TS' },
  { name: 'Tripura', code: 'TR' },
  { name: 'Uttar Pradesh', code: 'UP' },
  { name: 'Uttarakhand', code: 'UK' },
  { name: 'West Bengal', code: 'WB' },
  /// Union Territories
  { name: 'Andaman and Nicobar Islands', code: 'AN' },
  { name: 'Chandigarh', code: 'CH' },
  { name: 'Dadra and Nagar Haveli and Daman and Diu', code: 'DH' },
  { name: 'Delhi', code: 'DL' },
  { name: 'Jammu and Kashmir', code: 'JK' },
  { name: 'Ladakh', code: 'LA' },
  { name: 'Lakshadweep', code: 'LD' },
  { name: 'Puducherry', code: 'PY' },
];

/// Starter cities — the metros + tier-1 markets. Coordinates are
/// approximate centroids; admin can refine later. Add more cities by
/// either appending here and re-running, or via the admin UI.
const CITIES = [
  { state: 'Karnataka',    name: 'Bengaluru',  lat: 12.9716, lng: 77.5946 },
  { state: 'Karnataka',    name: 'Mysuru',     lat: 12.2958, lng: 76.6394 },
  { state: 'Karnataka',    name: 'Mangaluru',  lat: 12.9141, lng: 74.8560 },
  { state: 'Karnataka',    name: 'Hubballi',   lat: 15.3647, lng: 75.1240 },
  { state: 'Maharashtra',  name: 'Mumbai',     lat: 19.0760, lng: 72.8777 },
  { state: 'Maharashtra',  name: 'Pune',       lat: 18.5204, lng: 73.8567 },
  { state: 'Maharashtra',  name: 'Nagpur',     lat: 21.1458, lng: 79.0882 },
  { state: 'Telangana',    name: 'Hyderabad',  lat: 17.3850, lng: 78.4867 },
  { state: 'Tamil Nadu',   name: 'Chennai',    lat: 13.0827, lng: 80.2707 },
  { state: 'Tamil Nadu',   name: 'Coimbatore', lat: 11.0168, lng: 76.9558 },
  { state: 'Delhi',        name: 'Delhi',      lat: 28.6139, lng: 77.2090 },
  { state: 'Haryana',      name: 'Gurugram',   lat: 28.4595, lng: 77.0266 },
  { state: 'Uttar Pradesh',name: 'Noida',      lat: 28.5355, lng: 77.3910 },
  { state: 'West Bengal',  name: 'Kolkata',    lat: 22.5726, lng: 88.3639 },
  { state: 'Gujarat',      name: 'Ahmedabad',  lat: 23.0225, lng: 72.5714 },
  { state: 'Gujarat',      name: 'Surat',      lat: 21.1702, lng: 72.8311 },
  { state: 'Rajasthan',    name: 'Jaipur',     lat: 26.9124, lng: 75.7873 },
  { state: 'Kerala',       name: 'Kochi',      lat: 9.9312,  lng: 76.2673 },
  { state: 'Kerala',       name: 'Thiruvananthapuram', lat: 8.5241, lng: 76.9366 },
  { state: 'Punjab',       name: 'Chandigarh', lat: 30.7333, lng: 76.7794 },
];

async function main() {
  console.log('Seeding states...');
  const stateByName = new Map();
  for (const s of STATES) {
    const row = await prisma.state.upsert({
      where: { name: s.name },
      create: s,
      update: { code: s.code },
    });
    stateByName.set(s.name, row.id);
  }
  console.log(`  ✓ ${STATES.length} states ready`);

  console.log('Seeding cities...');
  let created = 0;
  let updated = 0;
  for (const c of CITIES) {
    const stateId = stateByName.get(c.state);
    if (!stateId) {
      console.warn(`  ! Skipping ${c.name} — unknown state "${c.state}"`);
      continue;
    }
    /// Composite-unique upsert (name + stateId): can't use the simple
    /// `where: { name: ... }` form because the same city name can
    /// legitimately exist in two different states.
    const existing = await prisma.city.findUnique({
      where: { name_stateId: { name: c.name, stateId } },
    });
    if (existing) {
      await prisma.city.update({
        where: { id: existing.id },
        data: { lat: c.lat, lng: c.lng },
      });
      updated += 1;
    } else {
      await prisma.city.create({
        data: { name: c.name, stateId, lat: c.lat, lng: c.lng },
      });
      created += 1;
    }
  }
  console.log(`  ✓ ${created} cities created, ${updated} updated`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
