// One-off: give every course a real thumbnail image (non-destructive).
// Run:  npx tsx scripts/set-thumbnails.ts   (uses .env DATABASE_URL)
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Topic-relevant Unsplash images keyed by a keyword found in the course title,
// with a reliable picsum fallback so a thumbnail always loads.
const BY_KEYWORD: Array<[RegExp, string]> = [
  [/react|typescript|javascript|web|frontend/i, 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=600&q=80'],
  [/node|nest|api|backend/i, 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&q=80'],
  [/python|data|machine learning|ai|science/i, 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&q=80'],
  [/flutter|dart|mobile|android|ios/i, 'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=600&q=80'],
  [/design|ux|ui|figma/i, 'https://images.unsplash.com/photo-1561070791-2526d30994b5?w=600&q=80'],
  [/cloud|devops|docker|kubernetes|aws/i, 'https://images.unsplash.com/photo-1667372393119-3d4c48d07fc9?w=600&q=80'],
  [/security|hacking|cyber/i, 'https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=600&q=80'],
  [/business|finance|marketing/i, 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=600&q=80'],
];

async function main() {
  const courses = await prisma.course.findMany({ select: { id: true, slug: true, title: true } });
  let updated = 0;
  for (const c of courses) {
    const match = BY_KEYWORD.find(([re]) => re.test(c.title));
    const thumbnail = match ? match[1] : `https://picsum.photos/seed/${c.slug}/600/360`;
    await prisma.course.update({ where: { id: c.id }, data: { thumbnail } });
    updated++;
  }
  console.log(`✅ Updated ${updated} course thumbnails`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
