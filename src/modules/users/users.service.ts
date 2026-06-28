import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  UpdateProfileDto,
  UpdateStudentProfileDto,
  UpdateInstructorProfileDto,
} from './dto/update-profile.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(paginationDto: PaginationDto, role?: Role) {
    const { page, limit, skip } = paginationDto;

    const where = role ? { role } : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          email: true,
          username: true,
          firstName: true,
          lastName: true,
          avatar: true,
          role: true,
          createdAt: true,
          isEmailVerified: true,
          instructorProfile: {
            select: {
              title: true,
              expertise: true,
              rating: true,
              totalReviews: true,
              totalStudents: true,
              isVerified: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        instructorProfile: {
          include: {
            availabilitySlots: true,
          },
        },
        studentProfile: true,
        courseCreated: {
          select: {
            id: true,
            title: true,
            thumbnail: true,
            rating: true,
            totalEnrollments: true,
            price: true,
            currency: true,
            status: true,
            publishedAt: true,
          },
        },
        enrollments: {
          select: {
            id: true,
            progressPercentage: true,
            enrolledAt: true,
            status: true,
            course: {
              select: {
                id: true,
                title: true,
                thumbnail: true,
                duration: true,
              },
            },
          },
        },
        reviews: {
          select: {
            id: true,
            rating: true,
            title: true,
            content: true,
            createdAt: true,
            course: {
              select: {
                id: true,
                title: true,
              },
            },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async updateProfile(id: string, updateProfileDto: UpdateProfileDto) {
    try {
      const user = await this.prisma.user.update({
        where: { id },
        data: updateProfileDto,
        include: {
          instructorProfile: true,
          studentProfile: true,
        },
      });

      return user;
    } catch (error) {
      if (error instanceof Error && (error as any).code === 'P2025') {
        throw new NotFoundException('User not found');
      }
      throw error;
    }
  }

  async updateStudentProfile(
    userId: string,
    updateDto: UpdateStudentProfileDto,
  ) {
    // Check if user exists and is a student
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { studentProfile: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== Role.STUDENT) {
      throw new BadRequestException('User is not a student');
    }

    // Update or create student profile
    const studentProfile = await this.prisma.studentProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...updateDto,
        dateOfBirth: updateDto.dateOfBirth
          ? new Date(updateDto.dateOfBirth)
          : undefined,
      },
      update: {
        ...updateDto,
        dateOfBirth: updateDto.dateOfBirth
          ? new Date(updateDto.dateOfBirth)
          : undefined,
      },
    });

    return studentProfile;
  }

  async updateInstructorProfile(
    userId: string,
    updateDto: UpdateInstructorProfileDto,
  ) {
    // Check if user exists and is an instructor
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { instructorProfile: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role !== Role.INSTRUCTOR) {
      throw new BadRequestException('User is not an instructor');
    }

    // Update or create instructor profile
    const instructorProfile = await this.prisma.instructorProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...updateDto,
      },
      update: updateDto,
    });

    return instructorProfile;
  }

  async deleteAccount(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

    const tombstone = `deleted_${Date.now()}_${id}`;

    // GDPR erasure in a single transaction:
    // - Wipe all PII and credentials from the user record
    // - Delete device tokens, notifications, wishlist entries
    // - Payment/enrollment records are retained for financial compliance
    //   but the user's PII fields are anonymised above
    await this.prisma.$transaction([
      // Erase auth credentials so account cannot be used
      this.prisma.userAuth.deleteMany({ where: { userId: id } }),
      // Remove push notification tokens
      this.prisma.deviceToken.deleteMany({ where: { userId: id } }),
      // Remove in-app notifications
      this.prisma.notification.deleteMany({ where: { userId: id } }),
      // Remove wishlist (no financial/legal reason to retain)
      this.prisma.wishlist.deleteMany({ where: { userId: id } }),
      // Anonymise the user record — keep the row for relational integrity
      // (enrollments, payment records reference userId)
      this.prisma.user.update({
        where: { id },
        data: {
          isActive:        false,
          email:           `${tombstone}@deleted.invalid`,
          username:        tombstone,
          firstName:       'Deleted',
          lastName:        'User',
          avatar:          null,
          bio:             null,
          isEmailVerified: false,
        },
      }),
    ]);

    return { message: 'Account and personal data permanently deleted' };
  }

  async getCourseStudents(instructorId: string, courseId: string, paginationDto: PaginationDto) {
    const { page, limit, skip } = paginationDto;

    // Verify the course belongs to this instructor
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    if (course.instructorId !== instructorId) {
      throw new ForbiddenException('You are not the instructor of this course');
    }

    const [enrollments, total] = await Promise.all([
      this.prisma.enrollment.findMany({
        where: { courseId },
        skip,
        take: limit,
        include: {
          user: {
            select: { id: true, firstName: true, lastName: true, email: true, avatar: true, createdAt: true },
          },
          lessonProgress: {
            select: { lessonId: true, isCompleted: true, watchTime: true, completedAt: true },
          },
        },
        orderBy: { enrolledAt: 'desc' },
      }),
      this.prisma.enrollment.count({ where: { courseId } }),
    ]);

    return {
      students: enrollments.map(e => ({
        enrollment: {
          id:                 e.id,
          status:             e.status,
          progressPercentage: Number(e.progressPercentage),
          enrolledAt:         e.enrolledAt,
          completedAt:        e.completedAt,
        },
        student:        e.user,
        lessonProgress: e.lessonProgress,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) },
    };
  }

  async getInstructors(paginationDto: PaginationDto) {
    const { page, limit, skip } = paginationDto;

    const [instructors, total] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          role: Role.INSTRUCTOR,
          isActive: true,
        },
        skip,
        take: limit,
        include: {
          instructorProfile: {
            select: {
              title: true,
              expertise: true,
              rating: true,
              totalReviews: true,
              totalStudents: true,
              hourlyRate: true,
              isVerified: true,
              isAvailableForSessions: true,
            },
          },
        },
        orderBy: {
          instructorProfile: {
            rating: 'desc',
          },
        },
      }),
      this.prisma.user.count({
        where: {
          role: Role.INSTRUCTOR,
          isActive: true,
        },
      }),
    ]);

    return {
      instructors,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }
}
