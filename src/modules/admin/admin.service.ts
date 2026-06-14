import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EmailService } from '../../common/email/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  Role,
  User,
  Course,
  CourseStatus,
  PaymentStatus,
  NotificationType,
  VideoStatus,
} from '@prisma/client';
import { VideoProcessingService } from '../video-processing/video-processing.service';
import * as bcryptjs from 'bcryptjs';

interface UserFilters {
  role?: Role;
  isActive?: boolean;
  search?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

interface CourseFilters {
  status?: CourseStatus;
  instructorId?: string;
  categoryId?: string;
  search?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

interface CreateUserData {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  password: string;
}

interface UpdateUserData {
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: Role;
  isActive?: boolean;
}

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly notificationsService: NotificationsService,
    private readonly videoProcessingService: VideoProcessingService,
  ) {}

  // User Management
  async getUsers(paginationDto: PaginationDto, filters: UserFilters = {}) {
    const { page, limit, skip } = paginationDto;

    const where: any = {};

    if (filters.role) {
      where.role = filters.role;
    }

    if (typeof filters.isActive === 'boolean') {
      where.isActive = filters.isActive;
    }

    if (filters.search) {
      where.OR = [
        { username: { contains: filters.search, mode: 'insensitive' } },
        { email: { contains: filters.search, mode: 'insensitive' } },
        { firstName: { contains: filters.search, mode: 'insensitive' } },
        { lastName: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters.createdAfter || filters.createdBefore) {
      where.createdAt = {};
      if (filters.createdAfter) where.createdAt.gte = filters.createdAfter;
      if (filters.createdBefore) where.createdAt.lte = filters.createdBefore;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          isActive: true,
          avatar: true,
          createdAt: true,
          updatedAt: true,
          lastLoginAt: true,
          _count: {
            select: {
              courseCreated: { where: { isPublished: true } },
              enrollments: true,
              reviews: true,
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

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        studentProfile: true,
        instructorProfile: true,
        courseCreated: {
          where: { isPublished: true },
          select: {
            id: true,
            title: true,
            thumbnail: true,
            createdAt: true,
            _count: {
              select: { enrollments: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        enrollments: {
          select: {
            id: true,
            createdAt: true,
            completedAt: true,
            course: {
              select: {
                id: true,
                title: true,
                thumbnail: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        _count: {
          select: {
            courseCreated: { where: { isPublished: true } },
            enrollments: true,
            reviews: true,
            certificates: true,
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Remove sensitive data (user from User model doesn't have these fields)
    return user;
  }

  async createUser(userData: CreateUserData) {
    // Check if username or email already exists
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: userData.username }, { email: userData.email }],
      },
    });

    if (existingUser) {
      throw new BadRequestException('Username or email already exists');
    }

    // Hash password
    const hashedPassword = await bcryptjs.hash(userData.password, 10);

    const user = await this.prisma.user.create({
      data: {
        username: userData.username,
        email: userData.email,
        firstName: userData.firstName,
        lastName: userData.lastName,
        role: userData.role,
        userAuth: {
          create: {
            passwordHash: hashedPassword,
          },
        },
        isActive: true,
      },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    // Create role-specific profile
    if (userData.role === Role.STUDENT) {
      await this.prisma.studentProfile.create({
        data: { userId: user.id },
      });
    } else if (userData.role === Role.INSTRUCTOR) {
      await this.prisma.instructorProfile.create({
        data: { userId: user.id },
      });
    }

    return user;
  }

  async updateUser(userId: string, updateData: UpdateUserData) {
    // Check if user exists
    const existingUser = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!existingUser) {
      throw new NotFoundException('User not found');
    }

    // Check for username/email conflicts if updating those fields
    if (updateData.username || updateData.email) {
      const conflictingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            ...(updateData.username ? [{ username: updateData.username }] : []),
            ...(updateData.email ? [{ email: updateData.email }] : []),
          ],
          NOT: { id: userId },
        },
      });

      if (conflictingUser) {
        throw new BadRequestException('Username or email already exists');
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return updatedUser;
  }

  async deactivateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === Role.ADMIN) {
      throw new ForbiddenException('Cannot deactivate admin users');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return updatedUser;
  }

  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        courseCreated: true,
        enrollments: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.role === Role.ADMIN) {
      throw new ForbiddenException('Cannot delete admin users');
    }

    // Check if user has active courses or enrollments
    if (user.courseCreated.length > 0) {
      throw new BadRequestException(
        'Cannot delete user with published courses',
      );
    }

    if (user.enrollments.length > 0) {
      throw new BadRequestException(
        'Cannot delete user with active enrollments',
      );
    }

    await this.prisma.user.delete({
      where: { id: userId },
    });

    return { success: true, message: 'User deleted successfully' };
  }

  // Course Management
  async getCourses(paginationDto: PaginationDto, filters: CourseFilters = {}) {
    const { page, limit, skip } = paginationDto;

    const where: any = {};

    if (filters.status) {
      where.status = filters.status;
    }

    if (filters.instructorId) {
      where.instructorId = filters.instructorId;
    }

    if (filters.categoryId) {
      where.categoryId = filters.categoryId;
    }

    if (filters.search) {
      where.OR = [
        { title: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters.createdAfter || filters.createdBefore) {
      where.createdAt = {};
      if (filters.createdAfter) where.createdAt.gte = filters.createdAfter;
      if (filters.createdBefore) where.createdAt.lte = filters.createdBefore;
    }

    const [courses, total] = await Promise.all([
      this.prisma.course.findMany({
        where,
        skip,
        take: limit,
        include: {
          instructor: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
            },
          },
          category: {
            select: {
              id: true,
              name: true,
            },
          },
          _count: {
            select: {
              enrollments: true,
              reviews: true,
              sections: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.course.count({ where }),
    ]);

    return {
      courses,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async approveCourse(courseId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (course.status !== CourseStatus.UNDER_REVIEW) {
      throw new BadRequestException('Course is not pending review');
    }

    const updatedCourse = await this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.PUBLISHED,
        isPublished: true,
        publishedAt: new Date(),
      },
      include: {
        instructor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    // Notify instructor
    const instructor = updatedCourse.instructor as any;
    if (instructor?.email) {
      const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? '';
      this.emailService
        .sendCourseApproved(instructor.email, `${instructor.firstName} ${instructor.lastName}`, updatedCourse.title, frontendUrl)
        .catch((e) => this.logger.warn(`Approval email failed: ${e.message}`));
    }

    this.notificationsService
      .createNotification({
        userId:    updatedCourse.instructorId,
        type:      NotificationType.COURSE_PUBLISHED,
        title:     'Course Approved! 🎉',
        message:   `Your course "${updatedCourse.title}" has been approved and is now live`,
        actionUrl: `/courses/${updatedCourse.id}`,
      })
      .catch(() => {});

    return updatedCourse;
  }

  async rejectCourse(courseId: string, reason?: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (course.status !== CourseStatus.UNDER_REVIEW) {
      throw new BadRequestException('Course is not pending review');
    }

    const updatedCourse = await this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.REJECTED,
        isPublished: false,
      },
      include: {
        instructor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    // Notify instructor
    const instructor = updatedCourse.instructor as any;
    if (instructor?.email) {
      const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? '';
      this.emailService
        .sendCourseRejected(
          instructor.email,
          `${instructor.firstName} ${instructor.lastName}`,
          updatedCourse.title,
          reason ?? 'Please review the course content guidelines and resubmit.',
          frontendUrl,
        )
        .catch((e) => this.logger.warn(`Rejection email failed: ${e.message}`));
    }

    this.notificationsService
      .createNotification({
        userId:    updatedCourse.instructorId,
        type:      NotificationType.SYSTEM_ALERT,
        title:     'Course Needs Revisions',
        message:   `Your course "${updatedCourse.title}" requires changes before publishing. ${reason ?? ''}`,
        actionUrl: `/instructor/courses/${updatedCourse.id}/edit`,
      })
      .catch(() => {});

    return updatedCourse;
  }

  async suspendCourse(courseId: string, reason?: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    const updatedCourse = await this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.ARCHIVED,
        isPublished: false,
      },
      include: {
        instructor: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    return updatedCourse;
  }

  // Category Management
  async createCategory(name: string, description?: string) {
    // Check if category already exists
    const existingCategory = await this.prisma.category.findUnique({
      where: { name },
    });

    if (existingCategory) {
      throw new BadRequestException('Category already exists');
    }

    const category = await this.prisma.category.create({
      data: {
        name,
        slug: name.toLowerCase().replace(/\s+/g, '-'),
        description,
      },
    });

    return category;
  }

  async updateCategory(
    categoryId: string,
    name?: string,
    description?: string,
  ) {
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Check for name conflicts if updating name
    if (name && name !== category.name) {
      const conflictingCategory = await this.prisma.category.findUnique({
        where: { name },
      });

      if (conflictingCategory) {
        throw new BadRequestException('Category name already exists');
      }
    }

    const updatedCategory = await this.prisma.category.update({
      where: { id: categoryId },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
      },
    });

    return updatedCategory;
  }

  async deleteCategory(categoryId: string) {
    const category = await this.prisma.category.findUnique({
      where: { id: categoryId },
      include: {
        _count: {
          select: { courses: true },
        },
      },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    if (category._count.courses > 0) {
      throw new BadRequestException(
        'Cannot delete category with existing courses',
      );
    }

    await this.prisma.category.delete({
      where: { id: categoryId },
    });

    return { success: true, message: 'Category deleted successfully' };
  }

  // System Statistics
  async getSystemStats() {
    const [userStats, courseStats, enrollmentStats, revenueStats] =
      await Promise.all([
        // User statistics
        this.prisma.user.groupBy({
          by: ['role'],
          _count: { id: true },
        }),

        // Course statistics
        this.prisma.course.aggregate({
          _count: { id: true },
          where: { isPublished: true },
        }),

        // Enrollment statistics
        this.prisma.enrollment.aggregate({
          _count: { id: true },
        }),

        // Revenue statistics
        this.prisma.payment.aggregate({
          _sum: { amount: true },
          where: { status: PaymentStatus.COMPLETED },
        }),
      ]);

    const userStatsObj = userStats.reduce(
      (acc, stat) => {
        acc[stat.role.toLowerCase()] = stat._count.id;
        return acc;
      },
      {} as Record<string, number>,
    );

    return {
      users: {
        total: Object.values(userStatsObj).reduce(
          (sum, count) => sum + count,
          0,
        ),
        ...userStatsObj,
      },
      courses: courseStats._count.id,
      enrollments: enrollmentStats._count.id,
      totalRevenue: revenueStats._sum?.amount || 0,
    };
  }

  async changeUserRole(userId: string, role: Role) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return this.prisma.user.update({ where: { id: userId }, data: { role } });
  }

  async activateUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    return this.prisma.user.update({ where: { id: userId }, data: { isActive: true } });
  }

  async listCategories() {
    return this.prisma.category.findMany({
      include: {
        _count: { select: { courses: true, children: true } },
        children: { select: { id: true, name: true, slug: true, isActive: true } },
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  // Recent Activity
  async getRecentActivity(limit: number = 50) {
    const [recentUsers, recentCourses, recentEnrollments] = await Promise.all([
      this.prisma.user.findMany({
        take: Math.ceil(limit / 3),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          role: true,
          createdAt: true,
        },
      }),

      this.prisma.course.findMany({
        take: Math.ceil(limit / 3),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          instructor: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
        },
      }),

      this.prisma.enrollment.findMany({
        take: Math.ceil(limit / 3),
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          user: {
            select: {
              firstName: true,
              lastName: true,
            },
          },
          course: {
            select: {
              title: true,
            },
          },
        },
      }),
    ]);

    const activities = [
      ...recentUsers.map((user) => ({
        id: user.id,
        type: 'user_registered',
        description: `${user.firstName} ${user.lastName} registered as ${user.role.toLowerCase()}`,
        timestamp: user.createdAt,
        data: { userId: user.id, role: user.role },
      })),
      ...recentCourses.map((course) => ({
        id: course.id,
        type: 'course_created',
        description: `${course.instructor.firstName} ${course.instructor.lastName} created course "${course.title}"`,
        timestamp: course.createdAt,
        data: { courseId: course.id, status: course.status },
      })),
      ...recentEnrollments.map((enrollment) => ({
        id: enrollment.id,
        type: 'user_enrolled',
        description: `${enrollment.user.firstName} ${enrollment.user.lastName} enrolled in "${enrollment.course.title}"`,
        timestamp: enrollment.createdAt,
        data: { enrollmentId: enrollment.id },
      })),
    ];

    return activities
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )
      .slice(0, limit);
  }

  async listNotifications(paginationDto: PaginationDto) {
    const { page, limit, skip } = paginationDto;

    // Group by batchId (stored in metadata JSON) so broadcasts appear as one row.
    // Falls back to individual id for notifications without a batchId.
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT
        COALESCE(metadata->>'batchId', id::text)   AS "batchId",
        MIN(id::text)                               AS id,
        type,
        title,
        message,
        "actionUrl",
        MIN("createdAt")                            AS "createdAt",
        COUNT(*)::int                               AS "recipientCount",
        bool_and("isRead")                          AS "allRead"
      FROM notifications
      GROUP BY COALESCE(metadata->>'batchId', id::text), type, title, message, "actionUrl"
      ORDER BY MIN("createdAt") DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const totalRaw = await this.prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(DISTINCT COALESCE(metadata->>'batchId', id::text)) AS count
      FROM notifications
    `;
    const total = Number(totalRaw[0].count);

    return {
      notifications: rows,
      pagination: { page, limit, total, pages: Math.ceil(total / (limit || 20)) },
    };
  }

  async updateNotification(id: string, data: { title?: string; message?: string; actionUrl?: string }) {
    // id may be a batchId string or an actual notification UUID.
    // Update all notifications sharing the same batchId (or the specific one).
    const sample = await this.prisma.notification.findFirst({
      where: {
        OR: [
          { id },
          // match by batchId stored in metadata
        ],
      },
    });

    if (!sample) throw new NotFoundException('Notification not found');

    const batchId = (sample.metadata as any)?.batchId as string | undefined;

    const updateData: any = {};
    if (data.title    !== undefined) updateData.title     = data.title;
    if (data.message  !== undefined) updateData.message   = data.message;
    if (data.actionUrl !== undefined) updateData.actionUrl = data.actionUrl;

    if (batchId) {
      await this.prisma.$executeRaw`
        UPDATE notifications
        SET
          title      = COALESCE(${data.title    ?? null}::text, title),
          message    = COALESCE(${data.message  ?? null}::text, message),
          "actionUrl"= COALESCE(${data.actionUrl ?? null}::text, "actionUrl")
        WHERE metadata->>'batchId' = ${batchId}
      `;
    } else {
      await this.prisma.notification.update({ where: { id }, data: updateData });
    }

    return { updated: true, batchId: batchId ?? id };
  }

  async deleteNotification(id: string) {
    const sample = await this.prisma.notification.findFirst({ where: { id } });
    if (!sample) throw new NotFoundException('Notification not found');

    const batchId = (sample.metadata as any)?.batchId as string | undefined;

    if (batchId) {
      await this.prisma.$executeRaw`
        DELETE FROM notifications WHERE metadata->>'batchId' = ${batchId}
      `;
    } else {
      await this.prisma.notification.delete({ where: { id } });
    }

    return { deleted: true };
  }

  // ── Instructor moderation ──────────────────────────────────────────────────

  async suspendInstructor(instructorId: string, reason: string) {
    const user = await this.prisma.user.findUnique({ where: { id: instructorId } });
    if (!user) throw new NotFoundException('Instructor not found');
    if (user.role !== Role.INSTRUCTOR) throw new BadRequestException('User is not an instructor');
    if (!user.isActive) throw new BadRequestException('Instructor is already suspended');

    await this.prisma.user.update({
      where: { id: instructorId },
      data: { isActive: false },
    });

    // In-app notification
    this.notificationsService.createNotification({
      userId:  instructorId,
      type:    NotificationType.SYSTEM_ALERT,
      title:   'Your account has been suspended',
      message: `Your instructor account has been suspended. Reason: ${reason}`,
    }).catch(() => {});

    // Email
    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? '';
    if (user.email) {
      this.emailService
        .sendInstructorSuspended(user.email, `${user.firstName} ${user.lastName}`, reason)
        .catch((e) => this.logger.warn(`Suspension email failed: ${e.message}`));
    }

    this.logger.log(`Instructor ${instructorId} suspended. Reason: ${reason}`);
    return { success: true, message: 'Instructor suspended', instructorId };
  }

  async warnInstructor(instructorId: string, message: string) {
    const user = await this.prisma.user.findUnique({ where: { id: instructorId } });
    if (!user) throw new NotFoundException('Instructor not found');
    if (user.role !== Role.INSTRUCTOR) throw new BadRequestException('User is not an instructor');

    // In-app notification
    await this.notificationsService.createNotification({
      userId:  instructorId,
      type:    NotificationType.SYSTEM_ALERT,
      title:   '⚠️ Account Warning',
      message: `You have received a formal warning from EduBridge administration: ${message}`,
    });

    // Email
    if (user.email) {
      this.emailService
        .sendInstructorWarning(user.email, `${user.firstName} ${user.lastName}`, message)
        .catch((e) => this.logger.warn(`Warning email failed: ${e.message}`));
    }

    this.logger.log(`Warning sent to instructor ${instructorId}`);
    return { success: true, message: 'Warning sent to instructor', instructorId };
  }

  async deleteInstructor(instructorId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: instructorId },
      include: {
        courseCreated: {
          select: { id: true, title: true, isPublished: true },
        },
      },
    });

    if (!user) throw new NotFoundException('Instructor not found');
    if (user.role !== Role.INSTRUCTOR) throw new BadRequestException('User is not an instructor');

    const courses = user.courseCreated as any[];

    // Archive all published courses so enrolled students keep their progress
    if (courses.length > 0) {
      await this.prisma.course.updateMany({
        where: { instructorId, isPublished: true },
        data: { status: CourseStatus.ARCHIVED, isPublished: false },
      });
      this.logger.log(`Archived ${courses.length} courses for instructor ${instructorId}`);
    }

    // Deactivate the account — hard delete is blocked by FK constraints from courses.
    // Deactivation is functionally equivalent: the user cannot log in and is invisible.
    await this.prisma.user.update({
      where: { id: instructorId },
      data: { isActive: false },
    });

    this.logger.log(`Instructor ${instructorId} deleted (deactivated). Courses archived: ${courses.length}`);

    return {
      success:         true,
      message:         'Instructor account deactivated and all courses archived',
      instructorId,
      coursesArchived: courses.length,
    };
  }

  // ── Reviews (superadmin visibility) ───────────────────────────────────────

  async getAllReviews(
    paginationDto: PaginationDto,
    filters: { courseId?: string; instructorId?: string; rating?: number } = {},
  ) {
    const { page, limit, skip } = paginationDto;

    const where: any = {};
    if (filters.courseId) where.courseId = filters.courseId;
    if (filters.rating)   where.rating   = filters.rating;
    if (filters.instructorId) {
      where.course = { instructorId: filters.instructorId };
    }

    const [reviews, total] = await Promise.all([
      this.prisma.review.findMany({
        where,
        skip,
        take: limit,
        include: {
          user:   { select: { id: true, firstName: true, lastName: true, username: true, avatar: true } },
          course: {
            select: {
              id:         true,
              title:      true,
              instructor: { select: { id: true, firstName: true, lastName: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.review.count({ where }),
    ]);

    return {
      reviews,
      pagination: { page, limit, total, pages: Math.ceil(total / (limit || 20)) },
    };
  }

  // ── Video moderation ───────────────────────────────────────────────────────

  async getPendingVideos(paginationDto: PaginationDto) {
    const { page, limit, skip } = paginationDto;

    const [videos, total] = await Promise.all([
      this.prisma.video.findMany({
        where: { status: VideoStatus.PENDING_REVIEW },
        skip,
        take: limit,
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              section: {
                select: {
                  title: true,
                  course: {
                    select: {
                      id: true,
                      title: true,
                      instructor: { select: { id: true, firstName: true, lastName: true, email: true } },
                    },
                  },
                },
              },
            },
          },
          variants: { select: { quality: true, resolution: true, duration: true } },
        },
        orderBy: { processingCompletedAt: 'asc' },
      }),
      this.prisma.video.count({ where: { status: VideoStatus.PENDING_REVIEW } }),
    ]);

    return {
      videos: videos.map((v) => ({
        id: v.id,
        originalFilename: v.originalFilename,
        thumbnailUrl: v.thumbnailUrl,
        duration: v.duration,
        fileSize: v.size?.toString(),
        processingCompletedAt: v.processingCompletedAt,
        submittedAt: v.createdAt,
        variants: v.variants,
        lesson: v.lesson
          ? {
              id: v.lesson.id,
              title: v.lesson.title,
              section: (v.lesson as any).section?.title,
              course: {
                id: (v.lesson as any).section?.course?.id,
                title: (v.lesson as any).section?.course?.title,
                instructor: (v.lesson as any).section?.course?.instructor,
              },
            }
          : null,
      })),
      pagination: { page, limit, total, pages: Math.ceil(total / (limit || 20)) },
    };
  }

  async approveVideo(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: true,
        lesson: {
          select: {
            id: true,
            title: true,
            section: {
              select: {
                course: {
                  select: {
                    id: true,
                    title: true,
                    instructor: { select: { id: true, firstName: true, lastName: true, email: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.PENDING_REVIEW) {
      throw new BadRequestException('Video is not in PENDING_REVIEW state');
    }

    const best =
      video.variants.find((v: any) => v.quality === '720p') ||
      video.variants.find((v: any) => v.quality === '480p') ||
      video.variants[0];

    // Make video live
    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.READY },
    });

    // Link to lesson so students can watch
    if (best && video.lessonId) {
      await this.prisma.lesson.update({
        where: { id: video.lessonId },
        data: { videoUrl: best.s3Url, duration: video.duration },
      });
    }

    const instructor = (video.lesson as any)?.section?.course?.instructor;
    const lessonTitle = video.lesson?.title ?? 'Unknown lesson';
    const courseId = (video.lesson as any)?.section?.course?.id;
    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? '';

    // Notify instructor in-app
    if (instructor) {
      this.notificationsService.createNotification({
        userId:    instructor.id,
        type:      NotificationType.SYSTEM_ALERT,
        title:     'Video approved!',
        message:   `Your video for lesson "${lessonTitle}" has been approved and is now live for students.`,
        actionUrl: `/instructor/courses/${courseId}`,
      }).catch(() => {});

      // Email
      if (instructor.email) {
        this.emailService
          .sendVideoApproved(instructor.email, `${instructor.firstName} ${instructor.lastName}`, lessonTitle, frontendUrl)
          .catch((e) => this.logger.warn(`Video approved email failed: ${e.message}`));
      }
    }

    this.logger.log(`Video ${videoId} approved by admin`);
    return { success: true, message: 'Video approved and is now live for students', videoId };
  }

  async rejectVideo(videoId: string, reason: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        lesson: {
          select: {
            id: true,
            title: true,
            section: {
              select: {
                course: {
                  select: {
                    id: true,
                    instructor: { select: { id: true, firstName: true, lastName: true, email: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.PENDING_REVIEW) {
      throw new BadRequestException('Video is not in PENDING_REVIEW state');
    }

    const instructor = (video.lesson as any)?.section?.course?.instructor;
    const lessonTitle = video.lesson?.title ?? 'Unknown lesson';
    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? '';

    // Delete S3 files + DB record (variants cascade via Prisma)
    await this.videoProcessingService.deleteVideoAdmin(videoId);

    // Notify instructor in-app
    if (instructor) {
      this.notificationsService.createNotification({
        userId:    instructor.id,
        type:      NotificationType.SYSTEM_ALERT,
        title:     'Video not approved',
        message:   `Your video for lesson "${lessonTitle}" was not approved. Reason: ${reason}`,
      }).catch(() => {});

      // Email
      if (instructor.email) {
        this.emailService
          .sendVideoRejected(instructor.email, `${instructor.firstName} ${instructor.lastName}`, lessonTitle, reason, frontendUrl)
          .catch((e) => this.logger.warn(`Video rejected email failed: ${e.message}`));
      }
    }

    this.logger.log(`Video ${videoId} rejected. Reason: ${reason}`);
    return { success: true, message: 'Video rejected, deleted, and instructor notified', videoId };
  }
}
