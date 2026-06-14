import {
  Injectable, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsString, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateAnnouncementDto {
  @ApiProperty() @IsString() title!: string;
  @ApiProperty() @IsString() content!: string;
  @ApiPropertyOptional({ default: true }) @IsOptional() @IsBoolean() isPublished?: boolean;
}

export class UpdateAnnouncementDto {
  @ApiPropertyOptional() @IsOptional() @IsString() title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() content?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPublished?: boolean;
}

@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);
  private get db() { return this.prisma as any; }

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async create(instructorId: string, courseId: string, dto: CreateAnnouncementDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { instructor: { select: { firstName: true, lastName: true } } },
    });
    if (!course) throw new NotFoundException('Course not found');
    if (course.instructorId !== instructorId) throw new ForbiddenException('Not your course');

    const announcement = await this.db.courseAnnouncement.create({
      data: {
        courseId,
        instructorId,
        title:       dto.title,
        content:     dto.content,
        isPublished: dto.isPublished ?? true,
      },
    });

    if (announcement.isPublished) {
      this.broadcastToEnrolledStudents(courseId, course, announcement).catch(() => {});
    }

    return announcement;
  }

  async update(instructorId: string, announcementId: string, dto: UpdateAnnouncementDto) {
    const ann = await this.db.courseAnnouncement.findUnique({ where: { id: announcementId } });
    if (!ann) throw new NotFoundException('Announcement not found');
    if (ann.instructorId !== instructorId) throw new ForbiddenException('Not your announcement');

    return this.db.courseAnnouncement.update({
      where: { id: announcementId },
      data: {
        ...(dto.title       !== undefined && { title: dto.title }),
        ...(dto.content     !== undefined && { content: dto.content }),
        ...(dto.isPublished !== undefined && { isPublished: dto.isPublished }),
      },
    });
  }

  async delete(instructorId: string, announcementId: string) {
    const ann = await this.db.courseAnnouncement.findUnique({ where: { id: announcementId } });
    if (!ann) throw new NotFoundException('Announcement not found');
    if (ann.instructorId !== instructorId) throw new ForbiddenException('Not your announcement');
    await this.db.courseAnnouncement.delete({ where: { id: announcementId } });
    return { message: 'Announcement deleted' };
  }

  async getCourseAnnouncements(courseId: string, pagination: PaginationDto, userId?: string) {
    const { page = 1, limit = 20, skip = 0 } = pagination;

    // Verify user is enrolled or is the instructor
    if (userId) {
      const course = await this.prisma.course.findUnique({ where: { id: courseId } });
      if (!course) throw new NotFoundException('Course not found');
      if (course.instructorId !== userId) {
        const enrollment = await this.prisma.enrollment.findFirst({
          where: { courseId, userId, status: 'ACTIVE' },
        });
        if (!enrollment) throw new ForbiddenException('You must be enrolled in this course');
      }
    }

    const [announcements, total] = await Promise.all([
      this.db.courseAnnouncement.findMany({
        where:   { courseId, isPublished: true },
        skip,
        take:    limit,
        include: { instructor: { select: { firstName: true, lastName: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.courseAnnouncement.count({ where: { courseId, isPublished: true } }),
    ]);

    return { announcements, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  private async broadcastToEnrolledStudents(courseId: string, course: any, announcement: any) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { courseId, status: 'ACTIVE' },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });

    for (const enrollment of enrollments) {
      const student = enrollment.user as any;
      this.notificationsService.createNotification({
        userId:    student.id,
        type:      'SYSTEM_ALERT' as any,
        title:     `New announcement: ${announcement.title}`,
        message:   announcement.content.slice(0, 200),
        actionUrl: `/courses/${courseId}/announcements`,
      }).catch(() => {});
    }

    this.logger.log(`Announcement "${announcement.title}" broadcasted to ${enrollments.length} students`);
  }
}
