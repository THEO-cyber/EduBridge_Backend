import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { EnrollmentStatus } from '@prisma/client';

@Injectable()
export class EnrollmentsService {
  constructor(private prisma: PrismaService) {}

  async getUserEnrollments(userId: string, paginationDto: PaginationDto) {
    const { page, limit, skip } = paginationDto;

    const [enrollments, total] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { userId },
        skip,
        take: limit,
        include: {
          course: {
            include: {
              instructor: {
                select: {
                  id: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                  avatar: true,
                },
              },
              category: true,
              _count: {
                select: {
                  sections: true,
                },
              },
            },
          },
          lessonProgress: {
            select: {
              lessonId: true,
              isCompleted: true,
              watchTime: true,
            },
          },
        },
        orderBy: { enrolledAt: 'desc' },
      }),
      this.prisma.enrollment.count({ where: { userId } }),
    ]);

    return {
      enrollments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async getEnrollmentDetails(enrollmentId: string, userId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        course: {
          include: {
            instructor: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                avatar: true,
              },
            },
            sections: {
              where: { isPublished: true },
              include: {
                lessons: {
                  where: { isPublished: true },
                  select: {
                    id: true,
                    title: true,
                    description: true,
                    sortOrder: true,
                    videoDuration: true,
                    videoUrl: true,
                    isPreview: true,
                  },
                  orderBy: { sortOrder: 'asc' },
                },
              },
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
        lessonProgress: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    if (enrollment.userId !== userId) {
      throw new ForbiddenException('Access denied to this enrollment');
    }

    return enrollment;
  }

  async updateLessonProgress(
    userId: string,
    lessonId: string,
    watchTime: number,
    isCompleted: boolean = false,
  ) {
    // Find enrollment for this lesson
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        section: {
          include: {
            course: {
              include: {
                enrollments: {
                  where: { userId },
                },
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    const enrollment = lesson.section.course.enrollments[0];
    if (!enrollment) {
      throw new ForbiddenException('Not enrolled in this course');
    }

    // Update or create lesson progress
    const lessonProgress = await this.prisma.lessonProgress.upsert({
      where: {
        enrollmentId_lessonId: {
          enrollmentId: enrollment.id,
          lessonId,
        },
      },
      create: {
        enrollmentId: enrollment.id,
        lessonId,
        watchTime,
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
      },
      update: {
        watchTime: Math.max(watchTime, 0), // Ensure watchTime is not negative
        isCompleted: isCompleted || undefined,
        completedAt: isCompleted ? new Date() : undefined,
      },
    });

    // Update course progress
    await this.updateCourseProgress(enrollment.id);

    return lessonProgress;
  }

  private async updateCourseProgress(enrollmentId: string) {
    // Get enrollment with all lesson progress
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        course: {
          include: {
            sections: {
              include: {
                lessons: {
                  where: { isPublished: true },
                },
              },
            },
          },
        },
        lessonProgress: true,
      },
    });

    if (!enrollment) return;

    // Count total and completed lessons
    const totalLessons = enrollment.course.sections.reduce(
      (total, section) => total + section.lessons.length,
      0,
    );

    const completedLessons = enrollment.lessonProgress.filter(
      (progress) => progress.isCompleted,
    ).length;

    const progressPercentage =
      totalLessons > 0
        ? Number(((completedLessons / totalLessons) * 100).toFixed(2))
        : 0;

    const isCompleted = progressPercentage === 100;

    // Update enrollment progress
    await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        progressPercentage,
        status: isCompleted
          ? EnrollmentStatus.COMPLETED
          : EnrollmentStatus.ACTIVE,
        completedAt: isCompleted ? new Date() : null,
      },
    });

    // If course is completed, generate certificate
    if (isCompleted && !enrollment.completedAt) {
      await this.generateCertificate(enrollmentId);
    }
  }

  private async generateCertificate(enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        user: true,
        course: true,
      },
    });

    if (!enrollment) return;

    // Generate unique certificate number
    const certificateNumber = `CERT-${Date.now()}-${enrollment.userId.slice(-6).toUpperCase()}`;

    await this.prisma.certificate.create({
      data: {
        enrollmentId,
        userId: enrollment.userId,
        courseId: enrollment.courseId,
        certificateNumber,
        issuedAt: new Date(),
      },
    });
  }

  async getCourseProgress(userId: string, courseId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: {
        userId_courseId: {
          userId,
          courseId,
        },
      },
      include: {
        lessonProgress: {
          include: {
            lesson: {
              select: {
                id: true,
                title: true,
                sortOrder: true,
                sectionId: true,
                videoDuration: true,
              },
            },
          },
        },
        course: {
          include: {
            sections: {
              include: {
                lessons: {
                  where: { isPublished: true },
                  select: {
                    id: true,
                    title: true,
                    sortOrder: true,
                    videoDuration: true,
                  },
                  orderBy: { sortOrder: 'asc' },
                },
              },
              orderBy: { sortOrder: 'asc' },
            },
          },
        },
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Enrollment not found');
    }

    return {
      enrollment,
      progressBySection: enrollment.course.sections.map((section) => ({
        sectionId: section.id,
        sectionTitle: section.title,
        lessons: section.lessons.map((lesson) => {
          const progress = enrollment.lessonProgress.find(
            (p) => p.lessonId === lesson.id,
          );
          return {
            ...lesson,
            isCompleted: progress?.isCompleted || false,
            watchTime: progress?.watchTime || 0,
            completedAt: progress?.completedAt,
          };
        }),
      })),
    };
  }
}
