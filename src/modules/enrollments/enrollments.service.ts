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
        watchTime: Math.max(watchTime, 0),
        // Once completed, keep it completed — never revert to false
        ...(isCompleted ? { isCompleted: true, completedAt: new Date() } : {}),
      },
    });

    // Recalculate overall course progress and issue certificate if finished
    await this.updateCourseProgress(enrollment.id);

    // Return updated enrollment progress so Flutter can refresh in one call
    const updated = await this.prisma.enrollment.findUnique({
      where: { id: enrollment.id },
      select: {
        progressPercentage: true,
        status: true,
        completedAt: true,
        certificate: { select: { id: true, certificateNumber: true, issuedAt: true } },
      },
    });

    return {
      lessonProgress,
      courseProgress: updated,
    };
  }

  private async updateCourseProgress(enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        course: {
          include: {
            sections: {
              where: { isPublished: true },
              include: {
                lessons: {
                  where: { isPublished: true },
                  select: { id: true },
                },
              },
            },
          },
        },
        lessonProgress: {
          where: { isCompleted: true },
          select: { lessonId: true },
        },
      },
    });

    if (!enrollment) return;

    // Only count published lessons against published lesson IDs
    const publishedLessonIds = new Set(
      enrollment.course.sections.flatMap((s) => s.lessons.map((l) => l.id)),
    );
    const totalLessons = publishedLessonIds.size;
    const completedLessons = enrollment.lessonProgress.filter((p) =>
      publishedLessonIds.has(p.lessonId),
    ).length;

    const progressPercentage =
      totalLessons > 0
        ? Number(((completedLessons / totalLessons) * 100).toFixed(2))
        : 0;

    const wasAlreadyComplete = !!(enrollment as any).completedAt;
    const isNowComplete = totalLessons > 0 && completedLessons >= totalLessons;

    await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        progressPercentage,
        status: isNowComplete ? EnrollmentStatus.COMPLETED : EnrollmentStatus.ACTIVE,
        // Only set completedAt once — never reset it back to null
        ...(isNowComplete && !wasAlreadyComplete ? { completedAt: new Date() } : {}),
      },
    });

    // Issue certificate exactly once, the moment the course is first completed
    if (isNowComplete && !wasAlreadyComplete) {
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
