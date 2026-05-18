require('dotenv').config();

const { PrismaClient } = require('@prisma/client');
const { SERVICE_FAQS_BY_NAME } = require('../prisma/service-faqs');

const prisma = new PrismaClient();

async function main() {
  let updated = 0;
  const missing = [];

  for (const [serviceName, faqs] of Object.entries(SERVICE_FAQS_BY_NAME)) {
    const service = await prisma.service.findFirst({
      where: { name: serviceName },
      select: { id: true, name: true },
    });

    if (!service) {
      missing.push(serviceName);
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.serviceFaq.deleteMany({ where: { serviceId: service.id } });
      await tx.serviceFaq.createMany({
        data: faqs.map((faq, index) => ({
          serviceId: service.id,
          question: faq.question,
          answer: faq.answer,
          sortOrder: index,
        })),
      });
    });

    updated += 1;
    console.log(`updated ${service.name}: ${faqs.length} FAQs`);
  }

  if (missing.length > 0) {
    console.warn(`Missing services: ${missing.join(', ')}`);
  }

  console.log(`Service FAQ seed complete. Updated ${updated} services.`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
