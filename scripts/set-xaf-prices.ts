// One-off: convert demo course prices from USD-magnitude to realistic XAF.
// Free courses stay free. Run: npx tsx scripts/set-xaf-prices.ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const toXaf = (usd: number) => Math.round((usd * 600) / 500) * 500; // ~USD→XAF, round to 500

async function main() {
  const courses = await prisma.course.findMany({
    select: { id: true, title: true, price: true, discountPrice: true },
  });
  let n = 0;
  for (const c of courses) {
    const usd = Number(c.price);
    if (usd <= 0) continue; // keep free courses free
    const data: any = { price: toXaf(usd), currency: 'XAF' };
    if (c.discountPrice && Number(c.discountPrice) > 0) {
      data.discountPrice = toXaf(Number(c.discountPrice));
    }
    await prisma.course.update({ where: { id: c.id }, data });
    console.log(`  ${c.title.slice(0, 40)} : ${usd} → ${toXaf(usd)} XAF`);
    n++;
  }
  console.log(`✅ Updated ${n} course prices to XAF`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
