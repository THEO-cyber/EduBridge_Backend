import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class WishlistService {
  constructor(private readonly prisma: PrismaService) {}

  async addToWishlist(userId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    try {
      await this.prisma.wishlist.create({ data: { userId, courseId } });
    } catch {
      throw new ConflictException('Course is already in your wishlist');
    }

    return { saved: true, courseId };
  }

  async removeFromWishlist(userId: string, courseId: string) {
    const item = await this.prisma.wishlist.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    if (!item) throw new NotFoundException('Course not in wishlist');

    await this.prisma.wishlist.delete({ where: { userId_courseId: { userId, courseId } } });
    return { removed: true, courseId };
  }

  async getWishlist(userId: string, pagination: PaginationDto) {
    const { page, limit, skip } = pagination;

    const [items, total] = await Promise.all([
      this.prisma.wishlist.findMany({
        where: { userId },
        skip,
        take: limit,
        include: {
          course: {
            include: {
              instructor: { select: { id: true, firstName: true, lastName: true, avatar: true } },
              category:   { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.wishlist.count({ where: { userId } }),
    ]);

    return {
      wishlist: items.map((i) => i.course),
      pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) },
    };
  }

  async isInWishlist(userId: string, courseId: string) {
    const item = await this.prisma.wishlist.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    return { inWishlist: !!item };
  }
}
