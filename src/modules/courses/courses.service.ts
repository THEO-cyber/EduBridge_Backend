import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CourseStatus, CourseLevel, Role } from '@prisma/client';

@Injectable()
export class CoursesService {
  constructor(private prisma: PrismaService) {}

  async create(instructorId: string, createCourseDto: CreateCourseDto) {
    // Validate category exists
    const category = await this.prisma.category.findUnique({
      where: { id: createCourseDto.categoryId },
    });

    if (!category || !category.isActive) {
      throw new BadRequestException('Invalid category');
    }

    // Generate unique slug
    const baseSlug = createCourseDto.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, '-');

    let slug = baseSlug;
    let counter = 1;

    while (await this.prisma.course.findUnique({ where: { slug } })) {
      slug = `${baseSlug}-${counter}`;
      counter++;
    }

    const course = await this.prisma.course.create({
      data: {
        ...createCourseDto,
        slug,
        instructorId,
        status: CourseStatus.DRAFT,
      },
      include: {
        instructor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            avatar: true,
            instructorProfile: {
              select: {
                title: true,
                expertise: true,
                rating: true,
                totalReviews: true,
                isVerified: true,
              },
            },
          },
        },
        category: true,
      },
    });

    return course;
  }

  async findAll(
    paginationDto: PaginationDto,
    filters?: {
      status?: CourseStatus;
      level?: CourseLevel;
      categoryId?: string;
      instructorId?: string;
      search?: string;
      minPrice?: number;
      maxPrice?: number;
    },
  ) {
    const { page, limit, skip } = paginationDto;

    const where: any = {
      isPublished: true,
      status: CourseStatus.PUBLISHED,
    };

    if (filters) {
      if (filters.status) where.status = filters.status;
      if (filters.level) where.level = filters.level;
      if (filters.categoryId) where.categoryId = filters.categoryId;
      if (filters.instructorId) where.instructorId = filters.instructorId;
      if (filters.search) {
        where.OR = [
          { title: { contains: filters.search, mode: 'insensitive' } },
          { description: { contains: filters.search, mode: 'insensitive' } },
          { tags: { hasSome: [filters.search] } },
        ];
      }
      if (filters.minPrice || filters.maxPrice) {
        where.price = {};
        if (filters.minPrice) where.price.gte = filters.minPrice;
        if (filters.maxPrice) where.price.lte = filters.maxPrice;
      }
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
              username: true,
              firstName: true,
              lastName: true,
              avatar: true,
              instructorProfile: {
                select: {
                  title: true,
                  rating: true,
                  totalReviews: true,
                  isVerified: true,
                },
              },
            },
          },
          category: true,
          _count: {
            select: {
              sections: true,
              enrollments: true,
              reviews: true,
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

  async findOne(id: string, userId?: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        instructor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            avatar: true,
            bio: true,
            instructorProfile: {
              select: {
                title: true,
                expertise: true,
                experience: true,
                rating: true,
                totalReviews: true,
                totalStudents: true,
                isVerified: true,
              },
            },
          },
        },
        category: true,
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
                isPreview: true,
              },
              orderBy: { sortOrder: 'asc' },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
        reviews: {
          take: 10,
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                avatar: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        _count: {
          select: {
            enrollments: true,
            reviews: true,
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    // Check if course is accessible
    if (!course.isPublished && course.instructorId !== userId) {
      throw new ForbiddenException('Course not accessible');
    }

    // Check if user is enrolled (if userId provided)
    let isEnrolled = false;
    if (userId) {
      const enrollment = await this.prisma.enrollment.findUnique({
        where: {
          userId_courseId: {
            userId,
            courseId: id,
          },
        },
      });
      isEnrolled = !!enrollment;
    }

    return {
      ...course,
      isEnrolled,
    };
  }

  async findBySlug(slug: string, userId?: string) {
    const course = await this.prisma.course.findUnique({
      where: { slug },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    return this.findOne(course.id, userId);
  }

  async update(
    id: string,
    instructorId: string,
    updateCourseDto: UpdateCourseDto,
  ) {
    // Check if course exists and user is the instructor
    const existingCourse = await this.prisma.course.findUnique({
      where: { id },
    });

    if (!existingCourse) {
      throw new NotFoundException('Course not found');
    }

    if (existingCourse.instructorId !== instructorId) {
      throw new ForbiddenException('Not authorized to update this course');
    }

    // Validate category if provided
    if (updateCourseDto.categoryId) {
      const category = await this.prisma.category.findUnique({
        where: { id: updateCourseDto.categoryId },
      });

      if (!category || !category.isActive) {
        throw new BadRequestException('Invalid category');
      }
    }

    // Update slug if title changed
    let updateData: any = { ...updateCourseDto };
    if (
      updateCourseDto.title &&
      updateCourseDto.title !== existingCourse.title
    ) {
      const baseSlug = updateCourseDto.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, '-');

      let slug = baseSlug;
      let counter = 1;

      while (
        await this.prisma.course.findFirst({
          where: { slug, id: { not: id } },
        })
      ) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      updateData.slug = slug;
    }

    const course = await this.prisma.course.update({
      where: { id },
      data: updateData,
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
      },
    });

    return course;
  }

  async remove(id: string, instructorId: string) {
    // Check if course exists and user is the instructor
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        enrollments: true,
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (course.instructorId !== instructorId) {
      throw new ForbiddenException('Not authorized to delete this course');
    }

    // Check if course has active enrollments
    if (course.enrollments.length > 0) {
      throw new BadRequestException(
        'Cannot delete course with active enrollments',
      );
    }

    await this.prisma.course.delete({
      where: { id },
    });

    return { message: 'Course successfully deleted' };
  }

  async publish(id: string, instructorId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        sections: {
          include: {
            lessons: true,
          },
        },
      },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    if (course.instructorId !== instructorId) {
      throw new ForbiddenException('Not authorized to publish this course');
    }

    // Validate course has required content
    if (course.sections.length === 0) {
      throw new BadRequestException('Course must have at least one section');
    }

    const totalLessons = course.sections.reduce(
      (sum, section) => sum + section.lessons.length,
      0,
    );

    if (totalLessons === 0) {
      throw new BadRequestException('Course must have at least one lesson');
    }

    const updatedCourse = await this.prisma.course.update({
      where: { id },
      data: {
        status: CourseStatus.UNDER_REVIEW,
        isPublished: false, // Will be set to true by admin after review
      },
    });

    return updatedCourse;
  }

  async getInstructorCourses(
    instructorId: string,
    paginationDto: PaginationDto,
  ) {
    const { page, limit, skip } = paginationDto;

    const [courses, total] = await Promise.all([
      this.prisma.course.findMany({
        where: { instructorId },
        skip,
        take: limit,
        include: {
          category: true,
          _count: {
            select: {
              sections: true,
              enrollments: true,
              reviews: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.course.count({ where: { instructorId } }),
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
}
