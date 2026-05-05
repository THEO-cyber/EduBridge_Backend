import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  Role,
  User,
  Course,
  CourseStatus,
  PaymentStatus,
} from '@prisma/client';
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
  constructor(private prisma: PrismaService) {}

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

    // TODO: Send notification to instructor about course approval

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

    // TODO: Send notification to instructor about course rejection

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
}
