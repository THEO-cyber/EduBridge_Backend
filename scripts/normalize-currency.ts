// One-off: force every course currency to XAF (free courses were left as USD).
// Run: npx tsx scripts/normalize-currency.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const res = await prisma.course.updateMany({
    where: { currency: { not: 'XAF' } },
    data: { currency: 'XAF' },
  });
  console.log(`✅ Normalized ${res.count} course(s) to XAF`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
