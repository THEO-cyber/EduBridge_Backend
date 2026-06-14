import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Role, PaymentStatus } from '@prisma/client';

interface DateRange {
  startDate: Date;
  endDate: Date;
}

interface EnrollmentTrend {
  date: string;
  count: number;
  revenue: number;
}

interface CategoryStats {
  categoryId: string;
  categoryName: string;
  coursesCount: number;
  enrollmentsCount: number;
  totalRevenue: number;
  averageRating: number;
}

interface InstructorStats {
  instructorId: string;
  name: string;
  coursesCount: number;
  enrollmentsCount: number;
  totalRevenue: number;
  averageRating: number;
  completionRate: number;
}

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  // Platform-wide analytics (Admin only)
  async getPlatformOverview(dateRange?: DateRange) {
    const whereCondition = dateRange
      ? {
          createdAt: {
            gte: dateRange.startDate,
            lte: dateRange.endDate,
          },
        }
      : {};

    const [
      totalUsers,
      totalCourses,
      totalEnrollments,
      totalRevenue,
      activeUsers,
      completedCourses,
    ] = await Promise.all([
      // Total users
      this.prisma.user.count({
        where: dateRange ? { createdAt: whereCondition.createdAt } : {},
      }),

      // Total courses
      this.prisma.course.count({
        where: {
          isPublished: true,
          ...whereCondition,
        },
      }),

      // Total enrollments
      this.prisma.enrollment.count({
        where: whereCondition,
      }),

      // Total revenue
      this.prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          status: PaymentStatus.COMPLETED,
          ...whereCondition,
        },
      }),

      // Active users (users who logged in within last 30 days)
      this.prisma.user.count({
        where: {
          lastLoginAt: {
            gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      }),

      // Completed courses
      this.prisma.enrollment.count({
        where: {
          completedAt: { not: null },
          ...whereCondition,
        },
      }),
    ]);

    const averageCompletionRate =
      totalEnrollments > 0 ? (completedCourses / totalEnrollments) * 100 : 0;

    return {
      totalUsers,
      totalCourses,
      totalEnrollments,
      totalRevenue: totalRevenue._sum?.amount || 0,
      activeUsers,
      completedCourses,
      averageCompletionRate: Math.round(averageCompletionRate * 100) / 100,
      dateRange,
    };
  }

  async getEnrollmentTrends(
    dateRange: DateRange,
    interval: 'day' | 'week' | 'month' = 'day',
  ) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        createdAt: {
          gte: dateRange.startDate,
          lte: dateRange.endDate,
        },
      },
      include: {
        course: {
          select: {
            price: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Group enrollments by date interval
    const trendsMap = new Map<string, { count: number; revenue: number }>();

    enrollments.forEach((enrollment) => {
      const date = enrollment.createdAt;
      let dateKey: string;

      switch (interval) {
        case 'day':
          dateKey = date.toISOString().split('T')[0];
          break;
        case 'week':
          const weekStart = new Date(
            date.getFullYear(),
            date.getMonth(),
            date.getDate() - date.getDay(),
          );
          dateKey = weekStart.toISOString().split('T')[0];
          break;
        case 'month':
          dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
          break;
      }

      if (!trendsMap.has(dateKey)) {
        trendsMap.set(dateKey, { count: 0, revenue: 0 });
      }

      const stats = trendsMap.get(dateKey);
      if (stats) {
        stats.count += 1;
        stats.revenue += Number(enrollment.course.price) || 0;
      }
    });

    const trends: EnrollmentTrend[] = Array.from(trendsMap.entries())
      .map(([date, stats]) => ({
        date,
        count: stats.count,
        revenue: stats.revenue,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return trends;
  }

  async getCategoryAnalytics(): Promise<CategoryStats[]> {
    const categories = await this.prisma.category.findMany({
      include: {
        courses: {
          where: { isPublished: true },
          include: {
            enrollments: true,
            reviews: {
              select: { rating: true },
            },
          },
        },
      },
    });

    return categories.map((category) => {
      const coursesCount = category.courses.length;
      const enrollmentsCount = category.courses.reduce(
        (sum, course) => sum + course.enrollments.length,
        0,
      );
      const totalRevenue = category.courses.reduce(
        (sum, course) =>
          sum + (Number(course.price) || 0) * course.enrollments.length,
        0,
      );

      const allRatings = category.courses.flatMap((course) =>
        course.reviews.map((review) => review.rating),
      );
      const averageRating =
        allRatings.length > 0
          ? allRatings.reduce((sum, rating) => sum + rating, 0) /
            allRatings.length
          : 0;

      return {
        categoryId: category.id,
        categoryName: category.name,
        coursesCount,
        enrollmentsCount,
        totalRevenue,
        averageRating: Math.round(averageRating * 100) / 100,
      };
    });
  }

  async getTopInstructors(limit: number = 10): Promise<InstructorStats[]> {
    const instructors = await this.prisma.user.findMany({
      where: { role: Role.INSTRUCTOR },
      include: {
        courseCreated: {
          where: { isPublished: true },
          include: {
            enrollments: {
              include: {
                course: { select: { price: true } },
              },
            },
            reviews: {
              select: { rating: true },
            },
          },
        },
      },
    });

    const instructorStats: InstructorStats[] = instructors
      .map((instructor) => {
        const coursesCount = instructor.courseCreated.length;
        const enrollmentsCount = instructor.courseCreated.reduce(
          (sum, course) => sum + course.enrollments.length,
          0,
        );
        const totalRevenue = instructor.courseCreated.reduce(
          (sum, course) =>
            sum + (Number(course.price) || 0) * course.enrollments.length,
          0,
        );

        const allRatings = instructor.courseCreated.flatMap((course) =>
          course.reviews.map((review) => review.rating),
        );
        const averageRating =
          allRatings.length > 0
            ? allRatings.reduce((sum, rating) => sum + rating, 0) /
              allRatings.length
            : 0;

        const completedEnrollments = instructor.courseCreated.reduce(
          (sum, course) =>
            sum + course.enrollments.filter((e) => e.completedAt).length,
          0,
        );
        const completionRate =
          enrollmentsCount > 0
            ? (completedEnrollments / enrollmentsCount) * 100
            : 0;

        return {
          instructorId: instructor.id,
          name: `${instructor.firstName} ${instructor.lastName}`,
          coursesCount,
          enrollmentsCount,
          totalRevenue,
          averageRating: Math.round(averageRating * 100) / 100,
          completionRate: Math.round(completionRate * 100) / 100,
        };
      })
      .sort((a, b) => b.totalRevenue - a.totalRevenue)
      .slice(0, limit);

    return instructorStats;
  }

  // Instructor-specific analytics
  async getInstructorAnalytics(instructorId: string, dateRange?: DateRange) {
    const whereCondition = dateRange
      ? {
          createdAt: {
            gte: dateRange.startDate,
            lte: dateRange.endDate,
          },
        }
      : {};

    const [courseStats, enrollmentStats, revenueStats, reviewStats] =
      await Promise.all([
        // Course statistics
        this.prisma.course.aggregate({
          _count: { id: true },
          where: {
            instructorId,
            isPublished: true,
            ...whereCondition,
          },
        }),

        // Enrollment statistics
        this.prisma.enrollment.findMany({
          where: {
            course: { instructorId },
            ...whereCondition,
          },
          include: {
            course: { select: { price: true, title: true } },
          },
        }),

        // Revenue from payments
        this.prisma.payment.aggregate({
          _sum: { amount: true },
          where: {
            status: PaymentStatus.COMPLETED,
            ...whereCondition,
          },
        }),

        // Review statistics
        this.prisma.review.findMany({
          where: {
            course: { instructorId },
            ...whereCondition,
          },
          select: { rating: true },
        }),
      ]);

    const totalEnrollments = enrollmentStats.length;
    const completedEnrollments = enrollmentStats.filter(
      (e) => e.completedAt,
    ).length;
    const completionRate =
      totalEnrollments > 0
        ? (completedEnrollments / totalEnrollments) * 100
        : 0;

    const averageRating =
      reviewStats.length > 0
        ? reviewStats.reduce((sum, review) => sum + review.rating, 0) /
          reviewStats.length
        : 0;

    // Course performance data
    const coursePerformance = await this.prisma.course.findMany({
      where: {
        instructorId,
        isPublished: true,
      },
      include: {
        enrollments: {
          where: dateRange ? whereCondition : {},
        },
        reviews: {
          where: dateRange ? whereCondition : {},
          select: { rating: true },
        },
        _count: {
          select: {
            enrollments: {
              where: dateRange ? whereCondition : {},
            },
          },
        },
      },
    });

    const topCourses = coursePerformance
      .map((course) => ({
        id: course.id,
        title: course.title,
        enrollments: course._count.enrollments,
        averageRating:
          course.reviews.length > 0
            ? course.reviews.reduce((sum, r) => sum + r.rating, 0) /
              course.reviews.length
            : 0,
        revenue: (Number(course.price) || 0) * course._count.enrollments,
      }))
      .sort((a, b) => b.enrollments - a.enrollments)
      .slice(0, 10);

    return {
      totalCourses: courseStats._count.id,
      totalEnrollments,
      completedEnrollments,
      completionRate: Math.round(completionRate * 100) / 100,
      totalRevenue: revenueStats._sum?.amount || 0,
      averageRating: Math.round(averageRating * 100) / 100,
      totalReviews: reviewStats.length,
      topCourses,
      dateRange,
    };
  }

  async getCourseAnalytics(courseId: string, userId: string, userRole: Role) {
    // Verify course ownership for instructors
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        sections: {
          include: {
            lessons: {
              select: { id: true, videoDuration: true },
            },
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (userRole === Role.INSTRUCTOR && course.instructorId !== userId) {
      throw new ForbiddenException(
        'Not authorized to view this course analytics',
      );
    }

    const [enrollmentStats, progressStats, reviewStats, completionStats] =
      await Promise.all([
        // Enrollment statistics
        this.prisma.enrollment.findMany({
          where: { courseId },
          include: {
            user: {
              select: { createdAt: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),

        // Progress statistics
        this.prisma.lessonProgress.findMany({
          where: {
            lesson: {
              section: {
                courseId,
              },
            },
          },
          include: {
            lesson: { select: { id: true, title: true, videoDuration: true } },
            enrollment: { select: { userId: true } },
          },
        }),

        // Review statistics
        this.prisma.review.findMany({
          where: { courseId },
          select: { rating: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),

        // Completion statistics
        this.prisma.enrollment.count({
          where: {
            courseId,
            completedAt: { not: null },
          },
        }),
      ]);

    const totalEnrollments = enrollmentStats.length;
    const completionRate =
      totalEnrollments > 0 ? (completionStats / totalEnrollments) * 100 : 0;

    const averageRating =
      reviewStats.length > 0
        ? reviewStats.reduce((sum, review) => sum + review.rating, 0) /
          reviewStats.length
        : 0;

    // Lesson engagement — grouped from progressStats by lesson
    const allLessons = course.sections.flatMap((s) => s.lessons);
    const lessonEngagement = allLessons.map((lesson) => {
      const rows = progressStats.filter((p) => p.lesson.id === lesson.id);
      const completions = rows.filter((p) => p.isCompleted).length;
      const avgWatch =
        rows.length > 0
          ? Math.round(rows.reduce((sum, p) => sum + (p as any).watchTime, 0) / rows.length)
          : 0;
      return {
        lessonId:         lesson.id,
        lessonTitle:      lesson.title,
        views:            rows.length,
        completions,
        completionRate:   rows.length > 0 ? Math.round((completions / rows.length) * 100) : 0,
        averageWatchTime: avgWatch,
        videoDuration:    lesson.videoDuration ?? null,
      };
    });

    // Enrollment trends over time
    const enrollmentTrends = this.groupEnrollmentsByDate(
      enrollmentStats.map((e) => e.createdAt),
    );

    return {
      courseId,
      courseTitle: course.title,
      totalEnrollments,
      completedEnrollments: completionStats,
      completionRate: Math.round(completionRate * 100) / 100,
      averageRating: Math.round(averageRating * 100) / 100,
      totalReviews: reviewStats.length,
      revenue: (Number(course.price) || 0) * totalEnrollments,
      lessonEngagement,
      enrollmentTrends,
    };
  }

  // Student analytics (for individual students)
  async getStudentProgress(studentId: string) {
    const [enrollments, completedCourses, totalWatchTime, certificates] =
      await Promise.all([
        // All enrollments
        this.prisma.enrollment.findMany({
          where: { userId: studentId },
          include: {
            course: {
              select: {
                id: true,
                title: true,
                thumbnail: true,
                sections: {
                  select: {
                    lessons: {
                      select: { id: true, videoDuration: true },
                    },
                  },
                },
              },
            },
            lessonProgress: {
              include: {
                lesson: { select: { duration: true } },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),

        // Completed courses
        this.prisma.enrollment.count({
          where: {
            userId: studentId,
            completedAt: { not: null },
          },
        }),

        // Total watch time
        this.prisma.lessonProgress.aggregate({
          _sum: { watchTime: true },
          where: {
            enrollment: { userId: studentId },
          },
        }),

        // Certificates
        this.prisma.certificate.count({
          where: { userId: studentId },
        }),
      ]);

    const courseProgress = enrollments.map((enrollment: any) => {
      const totalLessons = enrollment.course.sections.flatMap(
        (s: any) => s.lessons,
      ).length;
      const completedLessons = enrollment.lessonProgress.filter(
        (p: any) => p.completedAt,
      ).length;
      const progressPercentage =
        totalLessons > 0 ? (completedLessons / totalLessons) * 100 : 0;

      const totalDuration = enrollment.course.sections
        .flatMap((s: any) => s.lessons)
        .reduce(
          (sum: number, lesson: any) => sum + (lesson.videoDuration || 0),
          0,
        );
      const watchedDuration = enrollment.lessonProgress.reduce(
        (sum: number, progress: any) => sum + (progress.watchTime || 0),
        0,
      );

      return {
        courseId: enrollment.course.id,
        courseTitle: enrollment.course.title,
        thumbnail: enrollment.course.thumbnail,
        enrolledAt: enrollment.createdAt,
        completedAt: enrollment.completedAt,
        progressPercentage: Math.round(progressPercentage * 100) / 100,
        completedLessons,
        totalLessons,
        watchedDuration,
        totalDuration,
        timeSpent: watchedDuration,
      };
    });

    return {
      totalEnrollments: enrollments.length,
      completedCourses,
      certificatesEarned: certificates,
      totalWatchTime: totalWatchTime._sum.watchTime || 0,
      courseProgress,
      completionRate:
        enrollments.length > 0
          ? (completedCourses / enrollments.length) * 100
          : 0,
    };
  }

  private groupEnrollmentsByDate(dates: Date[]) {
    const grouped = new Map<string, number>();

    dates.forEach((date) => {
      const dateKey = date.toISOString().split('T')[0];
      grouped.set(dateKey, (grouped.get(dateKey) || 0) + 1);
    });

    return Array.from(grouped.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
