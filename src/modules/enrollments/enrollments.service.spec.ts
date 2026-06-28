import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EnrollmentsService } from './enrollments.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EnrollmentStatus } from '@prisma/client';

// ── Prisma mock ────────────────────────────────────────────────────────────────

const mockPrisma = {
  enrollment: {
    findMany:   jest.fn(),
    findUnique: jest.fn(),
    count:      jest.fn(),
    update:     jest.fn(),
  },
  lesson:         { findUnique: jest.fn() },
  lessonProgress: { upsert: jest.fn() },
  certificate:    { findFirst: jest.fn(), create: jest.fn() },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildEnrollment(overrides: Record<string, any> = {}) {
  return {
    id:                 'enrollment-1',
    userId:             'user-1',
    courseId:           'course-1',
    status:             EnrollmentStatus.ACTIVE,
    progressPercentage: 0,
    enrolledAt:         new Date(),
    completedAt:        null,
    ...overrides,
  };
}

// A lesson whose section.course has the given enrollments
function buildLesson(enrollments: any[] = [buildEnrollment()]) {
  return {
    id:    'lesson-1',
    title: 'Intro',
    section: {
      id:     'section-1',
      course: { id: 'course-1', enrollments },
    },
  };
}

// Enrollment shape expected by updateCourseProgress internals
function buildEnrollmentWithProgress(lessonIds: string[], completedIds: string[]) {
  return {
    ...buildEnrollment(),
    course: {
      sections: [{
        isPublished: true,
        lessons: lessonIds.map((id) => ({ id })),
      }],
    },
    lessonProgress: completedIds.map((lessonId) => ({ lessonId })),
  };
}

// Enrollment shape for generateCertificate
function buildEnrollmentWithRelations() {
  return {
    ...buildEnrollment(),
    user:   { id: 'user-1', firstName: 'Test', lastName: 'User', email: 'test@example.com' },
    course: { id: 'course-1', title: 'Test Course' },
  };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('EnrollmentsService', () => {
  let service: EnrollmentsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnrollmentsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<EnrollmentsService>(EnrollmentsService);
  });

  // ── getEnrollmentDetails ───────────────────────────────────────────────────

  describe('getEnrollmentDetails', () => {
    it('throws NotFoundException for unknown enrollment', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(null);
      await expect(service.getEnrollmentDetails('bad-id', 'user-1'))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when userId does not match', async () => {
      mockPrisma.enrollment.findUnique.mockResolvedValue(
        buildEnrollment({ userId: 'other-user' }),
      );
      await expect(service.getEnrollmentDetails('enrollment-1', 'user-1'))
        .rejects.toThrow(ForbiddenException);
    });

    it('returns enrollment when userId matches', async () => {
      const enrollment = buildEnrollment();
      mockPrisma.enrollment.findUnique.mockResolvedValue(enrollment);
      const result = await service.getEnrollmentDetails('enrollment-1', 'user-1');
      expect(result).toEqual(enrollment);
    });
  });

  // ── updateLessonProgress ───────────────────────────────────────────────────

  describe('updateLessonProgress', () => {
    it('throws NotFoundException when lesson does not exist', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(null);
      await expect(service.updateLessonProgress('user-1', 'lesson-x', 30, false))
        .rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user is not enrolled in the course', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(buildLesson([]));
      await expect(service.updateLessonProgress('user-1', 'lesson-1', 30, false))
        .rejects.toThrow(ForbiddenException);
    });

    it('upserts progress and returns updated course progress (no completion)', async () => {
      const lessonProgress = {
        enrollmentId: 'enrollment-1', lessonId: 'lesson-1', watchTime: 30, isCompleted: false,
      };
      mockPrisma.lesson.findUnique.mockResolvedValue(buildLesson());
      mockPrisma.lessonProgress.upsert.mockResolvedValue(lessonProgress);

      // updateCourseProgress: enrollment with 1 lesson, 0 completed → 0%
      mockPrisma.enrollment.findUnique
        .mockResolvedValueOnce(buildEnrollmentWithProgress(['lesson-1'], []))
        .mockResolvedValueOnce({
          progressPercentage: 0,
          status: EnrollmentStatus.ACTIVE,
          completedAt: null,
          certificate: null,
        });

      mockPrisma.enrollment.update.mockResolvedValue({});

      const result = await service.updateLessonProgress('user-1', 'lesson-1', 30, false);

      expect(result.lessonProgress).toEqual(lessonProgress);
      expect(result.courseProgress?.status).toBe(EnrollmentStatus.ACTIVE);
      // Certificate should NOT be generated for partial progress
      expect(mockPrisma.certificate.create).not.toHaveBeenCalled();
    });

    it('generates certificate when course is first completed', async () => {
      const lessonProgress = {
        enrollmentId: 'enrollment-1', lessonId: 'lesson-1', watchTime: 100, isCompleted: true,
      };
      mockPrisma.lesson.findUnique.mockResolvedValue(buildLesson());
      mockPrisma.lessonProgress.upsert.mockResolvedValue(lessonProgress);

      // updateCourseProgress: 1 lesson, 1 completed → 100% → COMPLETED
      mockPrisma.enrollment.findUnique
        .mockResolvedValueOnce(buildEnrollmentWithProgress(['lesson-1'], ['lesson-1']))
        .mockResolvedValueOnce(buildEnrollmentWithRelations())  // generateCertificate lookup
        .mockResolvedValueOnce({
          progressPercentage: 100,
          status: EnrollmentStatus.COMPLETED,
          completedAt: new Date(),
          certificate: { id: 'cert-1', certificateNumber: 'CERT-123', issuedAt: new Date() },
        });

      mockPrisma.enrollment.update.mockResolvedValue({});
      mockPrisma.certificate.create.mockResolvedValue({});

      const result = await service.updateLessonProgress('user-1', 'lesson-1', 100, true);

      expect(mockPrisma.certificate.create).toHaveBeenCalledTimes(1);
      expect(result.courseProgress?.status).toBe(EnrollmentStatus.COMPLETED);
    });

    it('never reverts a completed lesson to incomplete', async () => {
      mockPrisma.lesson.findUnique.mockResolvedValue(buildLesson());
      mockPrisma.lessonProgress.upsert.mockResolvedValue({
        enrollmentId: 'enrollment-1', lessonId: 'lesson-1', watchTime: 50, isCompleted: true,
      });
      mockPrisma.enrollment.findUnique
        .mockResolvedValueOnce(buildEnrollmentWithProgress(['lesson-1'], ['lesson-1']))
        .mockResolvedValueOnce(buildEnrollmentWithRelations())
        .mockResolvedValueOnce({
          progressPercentage: 100, status: EnrollmentStatus.COMPLETED,
          completedAt: new Date(), certificate: null,
        });
      mockPrisma.enrollment.update.mockResolvedValue({});
      mockPrisma.certificate.create.mockResolvedValue({});

      await service.updateLessonProgress('user-1', 'lesson-1', 50, false);

      // The upsert update block must NOT set isCompleted to false
      const upsertCall = mockPrisma.lessonProgress.upsert.mock.calls[0][0];
      expect(upsertCall.update).not.toHaveProperty('isCompleted', false);
    });
  });

  // ── getUserEnrollments ─────────────────────────────────────────────────────

  describe('getUserEnrollments', () => {
    it('returns paginated list with total and page count', async () => {
      mockPrisma.enrollment.findMany.mockResolvedValue([buildEnrollment()]);
      mockPrisma.enrollment.count.mockResolvedValue(1);

      const result = await service.getUserEnrollments('user-1', { page: 1, limit: 20, skip: 0 });

      expect(result.enrollments).toHaveLength(1);
      expect(result.pagination).toMatchObject({ total: 1, pages: 1, page: 1, limit: 20 });
    });
  });
});
