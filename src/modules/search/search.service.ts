import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CacheService } from '../../common/cache/cache.service';
import { CourseStatus } from '@prisma/client';
import { IsOptional, IsString, IsNumber, IsEnum, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchDto {
  @IsOptional() @IsString() q?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsEnum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'ALL_LEVELS']) level?: string;
  @IsOptional() @IsNumber() @Type(() => Number) @Min(0) priceMin?: number;
  @IsOptional() @IsNumber() @Type(() => Number) priceMax?: number;
  @IsOptional() @IsString() instructorId?: string;
  @IsOptional() @IsString() language?: string;
  @IsOptional() @IsString() sortBy?: 'rating' | 'enrollments' | 'price_asc' | 'price_desc' | 'newest';
  @IsOptional() @IsNumber() @Type(() => Number) @Min(1) page?: number;
  @IsOptional() @IsNumber() @Type(() => Number) @Min(1) @Max(50) limit?: number;
}

interface RawCourse {
  id: string;
  title: string;
  slug: string;
  shortDescription: string | null;
  thumbnail: string | null;
  price: number;
  rating: number;
  totalEnrollments: number;
  level: string;
  language: string;
  instructorId: string;
  instructorFirstName: string | null;
  instructorLastName: string | null;
  instructorAvatar: string | null;
  instructorUsername: string | null;
  categoryId: string | null;
  categoryName: string | null;
  categorySlug: string | null;
  rank: number;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  async searchCourses(dto: SearchDto) {
    const page  = dto.page  ?? 1;
    const limit = dto.limit ?? 20;
    const skip  = (page - 1) * limit;
    const q     = dto.q?.trim() ?? '';

    const cacheKey = !q && !dto.category && !dto.level && dto.priceMin === undefined && dto.priceMax === undefined
      ? CacheService.keys.courseList(page)
      : null;

    if (cacheKey) {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    }

    if (q) {
      return this.searchWithTrigram(q, dto, page, limit, skip);
    }

    return this.searchWithFilters(dto, page, limit, skip, cacheKey);
  }

  // Real pg_trgm similarity search via raw SQL
  private async searchWithTrigram(q: string, dto: SearchDto, page: number, limit: number, skip: number) {
    const conditions: string[] = [
      `c.status = '${CourseStatus.PUBLISHED}'`,
      `c."isPublished" = true`,
      `(
        similarity(c.title, $1) > 0.1
        OR similarity(c.description, $1) > 0.1
        OR similarity(c."shortDescription", $1) > 0.1
        OR c.title ILIKE '%' || $1 || '%'
        OR c."shortDescription" ILIKE '%' || $1 || '%'
        OR (u."firstName" || ' ' || u."lastName") ILIKE '%' || $1 || '%'
      )`,
    ];

    const params: (string | number)[] = [q];
    let paramIdx = 2;

    if (dto.level) {
      conditions.push(`c.level = $${paramIdx}`);
      params.push(dto.level);
      paramIdx++;
    }
    if (dto.instructorId) {
      conditions.push(`c."instructorId" = $${paramIdx}`);
      params.push(dto.instructorId);
      paramIdx++;
    }
    if (dto.language) {
      conditions.push(`c.language = $${paramIdx}`);
      params.push(dto.language);
      paramIdx++;
    }
    if (dto.priceMin !== undefined) {
      conditions.push(`c.price >= $${paramIdx}`);
      params.push(dto.priceMin);
      paramIdx++;
    }
    if (dto.priceMax !== undefined) {
      conditions.push(`c.price <= $${paramIdx}`);
      params.push(dto.priceMax);
      paramIdx++;
    }

    const categoryJoin = dto.category
      ? `JOIN "Category" cat ON cat.id = c."categoryId" AND (cat.id = $${paramIdx} OR cat.slug = $${paramIdx} OR cat.name ILIKE '%' || $${paramIdx} || '%')`
      : `LEFT JOIN "Category" cat ON cat.id = c."categoryId"`;

    if (dto.category) {
      params.push(dto.category);
      paramIdx++;
    }

    const orderBy = this.buildRawOrderBy(dto.sortBy, true);
    const whereClause = conditions.join(' AND ');

    const countSql = `
      SELECT COUNT(*) as total
      FROM "Course" c
      JOIN "User" u ON u.id = c."instructorId"
      ${categoryJoin}
      WHERE ${whereClause}
    `;

    const dataSql = `
      SELECT
        c.id, c.title, c.slug, c."shortDescription", c.thumbnail,
        c.price, c.rating, c."totalEnrollments", c.level, c.language,
        c."instructorId",
        u."firstName" as "instructorFirstName",
        u."lastName"  as "instructorLastName",
        u.avatar      as "instructorAvatar",
        u.username    as "instructorUsername",
        cat.id        as "categoryId",
        cat.name      as "categoryName",
        cat.slug      as "categorySlug",
        GREATEST(
          similarity(c.title, $1),
          similarity(COALESCE(c.description, ''), $1),
          similarity(COALESCE(c."shortDescription", ''), $1)
        ) as rank
      FROM "Course" c
      JOIN "User" u ON u.id = c."instructorId"
      ${categoryJoin}
      WHERE ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
    `;

    params.push(limit, skip);

    const [countResult, courses] = await Promise.all([
      this.prisma.$queryRawUnsafe<[{ total: string }]>(countSql, ...params.slice(0, params.length - 2)),
      this.prisma.$queryRawUnsafe<RawCourse[]>(dataSql, ...params),
    ]);

    const total = parseInt(countResult[0]?.total ?? '0', 10);
    return this.formatResult(courses, page, limit, total, q);
  }

  private async searchWithFilters(dto: SearchDto, page: number, limit: number, skip: number, cacheKey: string | null) {
    const where: any = {
      status:      CourseStatus.PUBLISHED,
      isPublished: true,
    };

    if (dto.level)        where.level        = dto.level;
    if (dto.instructorId) where.instructorId = dto.instructorId;
    if (dto.language)     where.language     = dto.language;

    if (dto.category) {
      where.category = {
        OR: [
          { id:   dto.category },
          { slug: dto.category },
          { name: { contains: dto.category, mode: 'insensitive' } },
        ],
      };
    }

    if (dto.priceMin !== undefined || dto.priceMax !== undefined) {
      where.price = {};
      if (dto.priceMin !== undefined) where.price.gte = dto.priceMin;
      if (dto.priceMax !== undefined) where.price.lte = dto.priceMax;
    }

    const orderBy = this.buildOrderBy(dto.sortBy);

    const [courses, total] = await Promise.all([
      this.prisma.course.findMany({
        where, skip, take: limit, orderBy,
        include: {
          instructor: { select: { id: true, firstName: true, lastName: true, avatar: true, username: true } },
          category:   { select: { id: true, name: true, slug: true } },
          _count:     { select: { sections: true, enrollments: true } },
        },
      }),
      this.prisma.course.count({ where }),
    ]);

    const result = { courses, pagination: { page, limit, total, pages: Math.ceil(total / limit) }, query: undefined };
    if (cacheKey) await this.cache.set(cacheKey, result, 120);
    return result;
  }

  async getSearchSuggestions(q: string) {
    if (!q || q.length < 2) return { suggestions: [] };

    const cacheKey = `search:suggest:${q.toLowerCase().slice(0, 30)}`;
    const cached = await this.cache.get<any>(cacheKey);
    if (cached) return cached;

    // Use trigram similarity for smarter suggestions
    const suggestions = await this.prisma.$queryRaw<Array<{ id: string; title: string; thumbnail: string | null; rating: number }>>`
      SELECT id, title, thumbnail, rating
      FROM "Course"
      WHERE status = ${CourseStatus.PUBLISHED}::"CourseStatus"
        AND "isPublished" = true
        AND (
          title ILIKE ${'%' + q + '%'}
          OR similarity(title, ${q}) > 0.15
        )
      ORDER BY similarity(title, ${q}) DESC, "totalEnrollments" DESC
      LIMIT 8
    `;

    const result = { suggestions };
    await this.cache.set(cacheKey, result, 300);
    return result;
  }

  async getPopularCategories() {
    const cached = await this.cache.get<any>(CacheService.keys.categories());
    if (cached) return cached;

    const categories = await this.prisma.category.findMany({
      where: { isActive: true, parentId: null },
      include: {
        _count:   { select: { courses: true } },
        children: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { courses: { _count: 'desc' } },
      take: 12,
    });

    const result = { categories };
    await this.cache.set(CacheService.keys.categories(), result, 600);
    return result;
  }

  async getFeaturedCourses() {
    const cached = await this.cache.get<any>(CacheService.keys.featuredCourses());
    if (cached) return cached;

    const courses = await this.prisma.course.findMany({
      where: { status: CourseStatus.PUBLISHED, isPublished: true },
      orderBy: [{ rating: 'desc' }, { totalEnrollments: 'desc' }],
      take: 12,
      include: {
        instructor: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        category:   { select: { id: true, name: true } },
      },
    });

    const result = { courses };
    await this.cache.set(CacheService.keys.featuredCourses(), result, 300);
    return result;
  }

  private formatResult(courses: RawCourse[], page: number, limit: number, total: number, query: string) {
    return {
      courses: courses.map(c => ({
        id:               c.id,
        title:            c.title,
        slug:             c.slug,
        shortDescription: c.shortDescription,
        thumbnail:        c.thumbnail,
        price:            c.price,
        rating:           c.rating,
        totalEnrollments: c.totalEnrollments,
        level:            c.level,
        language:         c.language,
        instructor: {
          id:        c.instructorId,
          firstName: c.instructorFirstName,
          lastName:  c.instructorLastName,
          avatar:    c.instructorAvatar,
          username:  c.instructorUsername,
        },
        category: c.categoryId ? {
          id:   c.categoryId,
          name: c.categoryName,
          slug: c.categorySlug,
        } : null,
        _rank: c.rank,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      query,
    };
  }

  private buildRawOrderBy(sortBy?: string, hasTrigram = false): string {
    switch (sortBy) {
      case 'rating':      return 'c.rating DESC';
      case 'enrollments': return 'c."totalEnrollments" DESC';
      case 'price_asc':   return 'c.price ASC';
      case 'price_desc':  return 'c.price DESC';
      case 'newest':      return 'c."publishedAt" DESC';
      default:            return hasTrigram ? 'rank DESC, c."totalEnrollments" DESC' : 'c."totalEnrollments" DESC, c.rating DESC';
    }
  }

  private buildOrderBy(sortBy?: string): any {
    switch (sortBy) {
      case 'rating':      return { rating: 'desc' };
      case 'enrollments': return { totalEnrollments: 'desc' };
      case 'price_asc':   return { price: 'asc' };
      case 'price_desc':  return { price: 'desc' };
      case 'newest':      return { publishedAt: 'desc' };
      default:            return [{ totalEnrollments: 'desc' }, { rating: 'desc' }];
    }
  }
}
