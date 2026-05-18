const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { SERVICE_FAQS_BY_NAME } = require('./service-faqs');

const prisma = new PrismaClient();

async function seedAdmin() {
  const passwordHash = await bcrypt.hash('Admin@123', 10);
  await prisma.admin.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: {
      email: 'admin@example.com',
      password: passwordHash,
      name: 'Super Admin',
    },
  });
}

const CATEGORIES = [
  {
    slug: 'ac-technician',
    name: 'AC Technician',
    icon: 'snowflake',
    color: '#2563EB',
    sortOrder: 1,
    /// Reused verified Unsplash photo from the original seed.
    bannerImageUrl: 'https://images.unsplash.com/photo-1631545806609-21b1d2b1c8a4?w=800',
    offerHeadline: 'AC service done right',
    offerSubtext: 'Trained pros · 30-day service warranty',
    offerPrice: 499,
  },
  {
    slug: 'electrician',
    name: 'Electrician',
    icon: 'zap',
    color: '#D97706',
    sortOrder: 2,
    /// No verified photo — fallback tile (icon + colour) renders.
    bannerImageUrl: null,
    offerHeadline: 'Trusted home electricians',
    offerSubtext: 'Licensed pros · Same-day visits',
    offerPrice: 199,
  },
  {
    slug: 'ro-technician',
    name: 'RO Technician',
    icon: 'droplets',
    color: '#0891B2',
    sortOrder: 3,
    bannerImageUrl: null,
    offerHeadline: 'Pure water, every day',
    offerSubtext: 'Service · Filter change · Install',
    offerPrice: 299,
  },
  {
    slug: 'plumber',
    name: 'Plumber',
    icon: 'shower-head',
    color: '#1E5A8E',
    sortOrder: 4,
    /// Reused verified geyser/water-heater install photo — fits plumbing.
    bannerImageUrl: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800',
    offerHeadline: 'Leaks fixed fast',
    offerSubtext: 'Quick visits · Genuine fittings',
    offerPrice: 249,
  },
  {
    slug: 'carpenter',
    name: 'Carpenter',
    icon: 'hammer',
    color: '#92400E',
    sortOrder: 5,
    bannerImageUrl: null,
    offerHeadline: 'Custom work, neat finish',
    offerSubtext: 'Furniture · Doors · Polishing',
    offerPrice: 349,
  },
  {
    slug: 'tv-technician',
    name: 'TV Technician',
    icon: 'tv',
    color: '#7C3AED',
    sortOrder: 6,
    bannerImageUrl: null,
    offerHeadline: 'TV setup, sorted',
    offerSubtext: 'Wall mount · Smart TV setup',
    offerPrice: 449,
  },
];

const SERVICES_BY_CATEGORY = {
  'ac-technician': [
    {
      name: 'AC Jet + Water Service',
      durationMins: 60,
      basePrice: 569,
      originalPrice: 999,
      description: 'High-pressure jet rinse for indoor and outdoor units.',
      imageUrl: 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=600',
      includes: ['Complete indoor unit cleaning', 'Drain tray, blower and coil deep-cleaning', 'Basic drain cleaning'],
      excludes: ['Gas refilling or coolant top-up', 'Major part repairs (compressor, motor, fan)'],
    },
    {
      name: 'AC Installation',
      durationMins: 120,
      basePrice: 1299,
      originalPrice: 1599,
      description: 'Wall-mount split AC installation with bracket and copper piping up to 2m.',
      imageUrl: 'https://images.unsplash.com/photo-1635005936977-5e889dba9b73?w=600',
      includes: ['Wall-bracket fitment', 'Up to 2m copper piping', 'Indoor + outdoor unit alignment', 'Demo and trial run'],
      excludes: ['Additional copper piping beyond 2m (chargeable)', 'Drilling charges for granite walls'],
    },
    {
      name: 'AC Gas Refill',
      durationMins: 90,
      basePrice: 1899,
      description: 'Top-up gas refill for split AC up to 1.5 ton.',
      includes: ['Pressure check', 'R-32 / R-410A gas refill', 'Leak diagnostics'],
      excludes: ['Replacement of coil or compressor'],
    },
    {
      name: 'AC Uninstallation',
      durationMins: 45,
      basePrice: 449,
      description: 'Safe removal of split AC indoor and outdoor units.',
      includes: ['Gas reclamation', 'Indoor + outdoor unit dismount', 'Safe packaging'],
      excludes: ['Wall plastering / patch-up'],
    },
  ],
  electrician: [
    {
      name: 'Switch & Socket Repair',
      durationMins: 30,
      basePrice: 199,
      originalPrice: 299,
      description: 'Replace faulty switches, sockets, regulators and outlets.',
      includes: ['Faulty switch / socket replacement', 'Loose-wire fixing', 'Continuity check'],
      excludes: ['New wiring runs (chargeable)'],
    },
    {
      name: 'Light & Fan Installation',
      durationMins: 45,
      basePrice: 349,
      originalPrice: 499,
      description: 'Mount and wire ceiling fans, light fixtures, chandeliers.',
      includes: ['Bracket / hook fitment', 'Wiring + connection', 'Trial run'],
      excludes: ['False-ceiling cutouts'],
    },
    {
      name: 'MCB & Wiring Fix',
      durationMins: 60,
      basePrice: 549,
      originalPrice: 799,
      description: 'Diagnose tripping MCB, short circuits and faulty wiring.',
      includes: ['Load testing', 'MCB / fuse replacement', 'Earth leakage check'],
      excludes: ['Full house rewiring'],
    },
    {
      name: 'Inverter / UPS Installation',
      durationMins: 75,
      basePrice: 699,
      originalPrice: 999,
      description: 'Install inverter or UPS with battery wiring and mains tie-in.',
      includes: ['Battery + inverter wiring', 'Mains changeover wiring', 'Load test'],
      excludes: ['Battery purchase'],
    },
  ],
  'ro-technician': [
    {
      name: 'RO Installation',
      durationMins: 60,
      basePrice: 599,
      originalPrice: 899,
      description: 'New RO water purifier installation including tap fitting.',
      includes: ['Wall mounting', 'Inlet plumbing tap fitment', 'Trial run + first flush'],
      excludes: ['Drilling on granite walls'],
    },
    {
      name: 'RO Filter Replacement',
      durationMins: 30,
      basePrice: 399,
      description: 'Replace sediment / carbon / membrane filters.',
      includes: ['Filter housing cleaning', 'Filter replacement', 'TDS check after replacement'],
      excludes: ['Membrane cost (chargeable separately)'],
    },
    {
      name: 'RO Service & Cleaning',
      durationMins: 45,
      basePrice: 299,
      description: 'Sanitisation, leak check and pressure tuning.',
      includes: ['Pressure pump check', 'Leak inspection', 'External sanitisation'],
      excludes: ['Filter replacement'],
    },
  ],
  plumber: [
    {
      name: 'Tap & Faucet Fitting',
      durationMins: 30,
      basePrice: 249,
      description: 'Replace or fit basin, kitchen and bathroom taps.',
      includes: ['Old tap removal', 'New tap fitment', 'Leak test'],
      excludes: ['Tap purchase'],
    },
    {
      name: 'Leak Repair',
      durationMins: 45,
      basePrice: 349,
      description: 'Diagnose and fix leaks in pipes, joints and concealed lines.',
      includes: ['Leak diagnosis', 'Joint / seal repair', 'Pressure test'],
      excludes: ['Concealed pipe replacement (chargeable)'],
    },
    {
      name: 'Geyser Installation',
      durationMins: 90,
      basePrice: 899,
      originalPrice: 1199,
      description: 'Wall-mount geyser install with safety valve and plumbing up to 1m.',
      imageUrl: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=600',
      includes: ['Wall mounting', 'Inlet/outlet plumbing up to 1m', 'Safety valve fitment'],
      excludes: ['Electrical wiring beyond outlet'],
    },
    {
      name: 'Bathroom Plumbing',
      durationMins: 90,
      basePrice: 749,
      description: 'Shower, jet, drain and basin plumbing repair.',
      includes: ['Diagnosis', 'Minor part replacement', 'Pressure check'],
      excludes: ['Tile breaking + relaying'],
    },
  ],
  carpenter: [
    {
      name: 'Furniture Assembly',
      durationMins: 90,
      basePrice: 449,
      description: 'Assemble flat-pack furniture — beds, wardrobes, racks.',
      includes: ['Full assembly', 'Levelling', 'Quality check'],
      excludes: ['Wall-anchor fitment beyond 6 holes'],
    },
    {
      name: 'Door Repair & Fitting',
      durationMins: 75,
      basePrice: 549,
      description: 'Hinge fix, latch replacement, sagging door realignment.',
      includes: ['Hinge / latch fix', 'Door realignment', 'Lock check'],
      excludes: ['Full door replacement'],
    },
    {
      name: 'Wood Polishing',
      durationMins: 120,
      basePrice: 899,
      description: 'Sanding + polish refresh for wooden furniture.',
      includes: ['Light sanding', 'Polish coat', 'Buff finish'],
      excludes: ['Deep restoration of damaged surfaces'],
    },
    {
      name: 'Custom Shelves & Brackets',
      durationMins: 90,
      basePrice: 649,
      description: 'Wall shelves, kitchen racks and bracket fitting.',
      includes: ['Drilling + fitment', 'Levelling', 'Cleanup'],
      excludes: ['Shelf material purchase'],
    },
  ],
  'tv-technician': [
    {
      name: 'TV Wall Mount',
      durationMins: 60,
      basePrice: 649,
      description: 'Wall mount up to 65" including bracket fitment.',
      includes: ['Bracket fitment', 'Cable management', 'Levelling'],
      excludes: ['Brick-wall drilling beyond 6 holes'],
    },
    {
      name: 'Smart TV Setup',
      durationMins: 45,
      basePrice: 449,
      description: 'WiFi setup, app login, picture/sound calibration.',
      includes: ['Network setup', 'OTT app login', 'Picture + sound calibration'],
      excludes: ['OTT subscription cost'],
    },
    {
      name: 'Cable & Antenna Setup',
      durationMins: 45,
      basePrice: 349,
      description: 'Cable / DTH / antenna setup and channel tuning.',
      includes: ['Wiring', 'Channel scan', 'Signal check'],
      excludes: ['Antenna / dish purchase'],
    },
  ],
};

async function seedCatalog() {
  // Use a deterministic id derived from the slug so re-runs are idempotent.
  const slugToId = {};

  for (const c of CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name: c.name } });
    const data = {
      name: c.name,
      icon: c.icon,
      color: c.color,
      sortOrder: c.sortOrder,
      active: c.active ?? true,
      bannerImageUrl: c.bannerImageUrl ?? null,
      offerHeadline: c.offerHeadline ?? null,
      offerSubtext: c.offerSubtext ?? null,
      offerPrice: c.offerPrice ?? null,
    };
    const cat = existing
      ? await prisma.category.update({ where: { id: existing.id }, data })
      : await prisma.category.create({ data });
    slugToId[c.slug] = cat.id;
  }

  for (const [slug, services] of Object.entries(SERVICES_BY_CATEGORY)) {
    const categoryId = slugToId[slug];
    if (!categoryId) continue;
    for (const s of services) {
      const existing = await prisma.service.findFirst({
        where: { name: s.name, categoryId },
      });
      const data = {
        name: s.name,
        description: s.description ?? '',
        imageUrl: s.imageUrl ?? null,
        durationMins: s.durationMins,
        basePrice: s.basePrice,
        originalPrice: s.originalPrice ?? null,
        active: s.active ?? true,
        includes: s.includes ?? [],
        excludes: s.excludes ?? [],
        categoryId,
      };
      if (existing) {
        await prisma.service.update({ where: { id: existing.id }, data });
      } else {
        await prisma.service.create({ data });
      }
    }
  }
}

async function seedServiceFaqs() {
  for (const [serviceName, faqs] of Object.entries(SERVICE_FAQS_BY_NAME)) {
    const service = await prisma.service.findFirst({
      where: { name: serviceName },
      select: { id: true },
    });
    if (!service) continue;

    await prisma.serviceFaq.deleteMany({ where: { serviceId: service.id } });
    await prisma.serviceFaq.createMany({
      data: faqs.map((faq, index) => ({
        serviceId: service.id,
        question: faq.question,
        answer: faq.answer,
        sortOrder: index,
      })),
    });
  }
}

const HOME_BANNERS = [
  {
    title: 'Home services made simple',
    subtitle: 'Verified pros. Upfront pricing. 30-day warranty.',
    imageUrl: 'https://images.unsplash.com/photo-1581578731548-c64695cc6952?w=1200',
    backgroundColor: '#2F5FFF',
    ctaType: 'NONE',
    ctaLabel: null,
    ctaValue: null,
    sortOrder: 1,
  },
  {
    title: '20% off AC service this week',
    subtitle: 'Beat the heat — book before Sunday',
    imageUrl: 'https://images.unsplash.com/photo-1631545806609-21b1d2b1c8a4?w=1200',
    backgroundColor: '#1F4AE6',
    ctaType: 'URL',
    ctaLabel: 'Book now',
    ctaValue: 'dhoond://promo/ac-service',
    sortOrder: 2,
  },
];

const SPOTLIGHT_BANNERS = [
  {
    title: 'AC Service from ₹499',
    subtitle: 'Jet wash + foam clean',
    imageUrl: 'https://images.unsplash.com/photo-1581094794329-c8112a89af12?w=600',
    backgroundColor: '#10B981',
    ctaType: 'NONE',
    ctaLabel: 'Explore',
    ctaValue: null,
    sortOrder: 1,
  },
  {
    title: 'Refrigerator repair',
    subtitle: 'Same-day visits',
    imageUrl: 'https://images.unsplash.com/photo-1601628828688-632f38a5a7d0?w=600',
    backgroundColor: '#F59E0B',
    ctaType: 'NONE',
    ctaLabel: 'See plans',
    ctaValue: null,
    sortOrder: 2,
  },
  {
    title: 'Geyser installation',
    subtitle: 'Done in under 2 hours',
    imageUrl: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=600',
    backgroundColor: '#8B5CF6',
    ctaType: 'NONE',
    ctaLabel: 'Book',
    ctaValue: null,
    sortOrder: 3,
  },
];

async function seedBanners() {
  const seed = async (placement, rows) => {
    for (const r of rows) {
      const existing = await prisma.appBanner.findFirst({
        where: { placement, title: r.title },
      });
      const data = { ...r, placement };
      if (existing) {
        await prisma.appBanner.update({ where: { id: existing.id }, data });
      } else {
        await prisma.appBanner.create({ data });
      }
    }
  };
  await seed('HOME_HERO', HOME_BANNERS);
  await seed('SPOTLIGHT', SPOTLIGHT_BANNERS);
}

async function seedServiceAreas() {
  // Phase-1 launch city — admins can add/restrict from the panel.
  await prisma.serviceArea.upsert({
    where: { city: 'Bengaluru' },
    update: {},
    create: {
      city: 'Bengaluru',
      state: 'Karnataka',
      pincodes: [],
      categoryIds: [],
      active: true,
    },
  });
}

async function seedTimeSlots() {
  // Default 3-window schedule. Admins can add, edit or disable from the
  // panel — these are just the starting point for a fresh DB.
  const defaults = [
    { label: 'Morning',   startTime: '09:00', endTime: '12:00', icon: 'sunny',         sortOrder: 1, capacity: 10 },
    { label: 'Afternoon', startTime: '12:00', endTime: '16:00', icon: 'partly-sunny',  sortOrder: 2, capacity: 10 },
    { label: 'Evening',   startTime: '16:00', endTime: '20:00', icon: 'moon',          sortOrder: 3, capacity: 10 },
  ];
  for (const s of defaults) {
    const existing = await prisma.timeSlot.findFirst({ where: { label: s.label } });
    if (existing) continue;
    await prisma.timeSlot.create({ data: s });
  }
}

async function main() {
  await seedAdmin();
  await seedCatalog();
  await seedServiceFaqs();
  await seedBanners();
  await seedServiceAreas();
  await seedTimeSlots();
  console.log('Seed complete.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
