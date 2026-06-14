import {
  Injectable, NotFoundException, ForbiddenException,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EnrollmentStatus } from '@prisma/client';

export class CreateReviewDto {
  @IsString() courseId!: string;
  @IsInt() @Min(1) @Max(5) @Type(() => Number) rating!: number;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() content?: string;
}

export class UpdateReviewDto {
  @IsOptional() @IsInt() @Min(1) @Max(5) @Type(() => Number) rating?: number;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() content?: string;
}

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  async createReview(userId: string, dto: CreateReviewDto) {
    // Must have an active or completed enrollment
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: dto.courseId } },
      select: { status: true },
    });
    if (
      !enrollment ||
      (enrollment.status !== EnrollmentStatus.ACTIVE &&
        enrollment.status !== EnrollmentStatus.COMPLETED)
    ) {
      throw new ForbiddenException('You must be enrolled in this course to leave a review');
    }

    const existing = await this.prisma.review.findUnique({
      where: { userId_courseId: { userId, courseId: dto.courseId } },
    });
    if (existing) throw new ConflictException('You have already reviewed this course');

    const review = await this.prisma.review.create({
      data: {
        userId,
        courseId:          dto.courseId,
        rating:            dto.rating,
        title:             dto.title,
        content:           dto.content,
        isVerifiedPurchase: true,
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatar: true, username: true } },
      },
    });

    await this.updateCourseRating(dto.courseId);
    return review;
  }

  async getCourseReviews(courseId: string, pagination: PaginationDto) {
    const { page, limit, skip } = pagination;

    const [reviews, total, ratingBreakdown] = await Promise.all([
      this.prisma.review.findMany({
        where: { courseId },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, avatar: true, username: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.review.count({ where: { courseId } }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where: { courseId },
        _count: { rating: true },
      }),
    ]);

    // Build rating distribution 1–5
    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratingBreakdown) distribution[r.rating] = r._count.rating;

    const avgRating = reviews.length
      ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
      : 0;

    return {
      reviews,
      avgRating: Math.round(avgRating * 10) / 10,
      ratingDistribution: distribution,
      pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) },
    };
  }

  async updateReview(reviewId: string, userId: string, dto: UpdateReviewDto) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Review not found');
    if (review.userId !== userId) throw new ForbiddenException();

    const updated = await this.prisma.review.update({
      where: { id: reviewId },
      data: { rating: dto.rating, title: dto.title, content: dto.content },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    await this.updateCourseRating(review.courseId);
    return updated;
  }

  async deleteReview(reviewId: string, userId: string, isAdmin = false) {
    const review = await this.prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new NotFoundException('Review not found');
    if (!isAdmin && review.userId !== userId) throw new ForbiddenException();

    await this.prisma.review.delete({ where: { id: reviewId } });
    await this.updateCourseRating(review.courseId);
    return { success: true };
  }

  async getUserReview(userId: string, courseId: string) {
    return this.prisma.review.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
  }

  private async updateCourseRating(courseId: string) {
    const result = await this.prisma.review.aggregate({
      where: { courseId },
      _avg: { rating: true },
      _count: { rating: true },
    });

    await this.prisma.course.update({
      where: { id: courseId },
      data: {
        rating:       result._avg.rating ?? 0,
        totalReviews: result._count.rating,
      },
    });
  }
}
