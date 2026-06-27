import {
  Injectable, NotFoundException, ForbiddenException, UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  IsString, IsOptional, IsNumber, IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export class CreateSectionDto {
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsNumber() @Type(() => Number) sortOrder!: number;
}

export class UpdateSectionDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Type(() => Number) sortOrder?: number;
  @IsOptional() @IsBoolean() isPublished?: boolean;
}

export class CreateLessonDto {
  @IsString() sectionId!: string;
  @IsString() title!: string;
  @IsOptional() @IsString() description?: string;
  @IsNumber() @Type(() => Number) sortOrder!: number;
  @IsOptional() @IsString() videoUrl?: string;
  @IsOptional() @IsNumber() @Type(() => Number) videoDuration?: number;
  @IsOptional() @IsBoolean() isPreview?: boolean;
  @IsOptional() @IsString() releaseAt?: string; // ISO date for content drip
}

export class UpdateLessonDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Type(() => Number) sortOrder?: number;
  @IsOptional() @IsString() videoUrl?: string;
  @IsOptional() @IsNumber() @Type(() => Number) videoDuration?: number;
  @IsOptional() @IsBoolean() isPreview?: boolean;
  @IsOptional() @IsBoolean() isPublished?: boolean;
  @IsOptional() @IsString() releaseAt?: string; // ISO date for content drip
}

export class ReorderDto {
  @IsString({ each: true }) ids!: string[]; // ordered array of IDs
}

// ─── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class LessonsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Sections ─────────────────────────────────────────────────────────────

  async createSection(courseId: string, instructorId: string, dto: CreateSectionDto) {
    await this.assertCourseOwner(courseId, instructorId);
    return this.prisma.section.create({
      data: { courseId, title: dto.title, description: dto.description, sortOrder: dto.sortOrder },
    });
  }

  async getSections(courseId: string, instructorId?: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');

    const where: any = { courseId };
    if (!instructorId || course.instructorId !== instructorId) {
      where.isPublished = true; // students only see published sections
    }

    const isInstructor = !!(instructorId && course.instructorId === instructorId);

    return this.prisma.section.findMany({
      where,
      include: {
        lessons: {
          where: isInstructor ? {} : { isPublished: true },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true, title: true, description: true, sortOrder: true,
            videoDuration: true, isPreview: true, isPublished: true,
            videos: {
              select: { id: true, status: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async updateSection(sectionId: string, instructorId: string, dto: UpdateSectionDto) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: { course: { select: { instructorId: true } } },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (section.course.instructorId !== instructorId) throw new ForbiddenException();

    return this.prisma.section.update({ where: { id: sectionId }, data: dto });
  }

  async deleteSection(sectionId: string, instructorId: string) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: { course: { select: { instructorId: true } } },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (section.course.instructorId !== instructorId) throw new ForbiddenException();

    await this.prisma.section.delete({ where: { id: sectionId } });
    return { success: true };
  }

  async reorderSections(courseId: string, instructorId: string, dto: ReorderDto) {
    await this.assertCourseOwner(courseId, instructorId);

    await this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.section.update({ where: { id }, data: { sortOrder: index + 1 } }),
      ),
    );

    return this.getSections(courseId, instructorId);
  }

  // ─── Lessons ──────────────────────────────────────────────────────────────

  async createLesson(instructorId: string, dto: CreateLessonDto) {
    const section = await this.prisma.section.findUnique({
      where: { id: dto.sectionId },
      include: { course: { select: { instructorId: true } } },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (section.course.instructorId !== instructorId) throw new ForbiddenException();

    return this.prisma.lesson.create({
      data: {
        sectionId:    dto.sectionId,
        title:        dto.title,
        description:  dto.description,
        sortOrder:    dto.sortOrder,
        videoUrl:     dto.videoUrl,
        videoDuration: dto.videoDuration,
        isPreview:    dto.isPreview ?? false,
        releaseAt:    dto.releaseAt ? new Date(dto.releaseAt) : null,
      } as any,
    });
  }

  async getLesson(lessonId: string, userId?: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        section: { include: { course: { select: { instructorId: true, id: true } } } },
        videos: { where: { status: 'READY' }, include: { variants: true }, take: 1 },
        attachments: true,
      },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');

    // Preview lessons are public; all others require auth + enrollment
    if (!lesson.isPreview) {
      if (!userId) throw new UnauthorizedException('Please log in to access this lesson');

      const isInstructor = lesson.section.course.instructorId === userId;

      if (!isInstructor) {
        const enrolled = await this.prisma.enrollment.findUnique({
          where: { userId_courseId: { userId, courseId: lesson.section.course.id } },
        });
        if (!enrolled) throw new ForbiddenException('Enroll in this course to access this lesson');

        const releaseAt = (lesson as any).releaseAt as Date | null;
        if (releaseAt && releaseAt > new Date()) {
          throw new ForbiddenException(
            `This lesson is not available until ${releaseAt.toISOString()}`,
          );
        }
      }
    }

    return lesson;
  }

  async updateLesson(lessonId: string, instructorId: string, dto: UpdateLessonDto) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { section: { include: { course: { select: { instructorId: true } } } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.section.course.instructorId !== instructorId) throw new ForbiddenException();

    return this.prisma.lesson.update({
      where: { id: lessonId },
      data: {
        ...(dto.title         !== undefined && { title: dto.title }),
        ...(dto.description   !== undefined && { description: dto.description }),
        ...(dto.sortOrder     !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.videoUrl      !== undefined && { videoUrl: dto.videoUrl }),
        ...(dto.videoDuration !== undefined && { videoDuration: dto.videoDuration }),
        ...(dto.isPreview     !== undefined && { isPreview: dto.isPreview }),
        ...(dto.isPublished   !== undefined && { isPublished: dto.isPublished }),
        ...(dto.releaseAt     !== undefined && { releaseAt: dto.releaseAt ? new Date(dto.releaseAt) : null }),
      } as any,
    });
  }

  async deleteLesson(lessonId: string, instructorId: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { section: { include: { course: { select: { instructorId: true } } } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.section.course.instructorId !== instructorId) throw new ForbiddenException();

    await this.prisma.lesson.delete({ where: { id: lessonId } });
    return { success: true };
  }

  async reorderLessons(sectionId: string, instructorId: string, dto: ReorderDto) {
    const section = await this.prisma.section.findUnique({
      where: { id: sectionId },
      include: { course: { select: { instructorId: true } } },
    });
    if (!section) throw new NotFoundException('Section not found');
    if (section.course.instructorId !== instructorId) throw new ForbiddenException();

    await this.prisma.$transaction(
      dto.ids.map((id, index) =>
        this.prisma.lesson.update({ where: { id }, data: { sortOrder: index + 1 } }),
      ),
    );

    return { success: true };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async assertCourseOwner(courseId: string, instructorId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    if (course.instructorId !== instructorId) throw new ForbiddenException('Not your course');
  }
}
