import {
  Injectable, NotFoundException, BadRequestException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../../common/email/email.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsString, IsOptional, IsArray, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class SubmitApplicationDto {
  @ApiProperty({ description: 'Why do you want to teach on EduBridge?' })
  @IsString() motivation!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() teachingExperience?: string;

  @ApiProperty({ description: 'List of subjects/topics you will teach', type: [String] })
  @IsArray() @IsString({ each: true }) subjectExpertise!: string[];

  @ApiPropertyOptional({ description: 'URL to a sample lesson, portfolio, or video' })
  @IsOptional() @IsString() sampleContentUrl?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() linkedinUrl?: string;
}

export class ReviewApplicationDto {
  @ApiProperty({ enum: ['approved', 'rejected'] })
  @IsIn(['approved', 'rejected']) decision!: string;

  @ApiPropertyOptional({ description: 'Required when decision is "rejected"' })
  @IsOptional() @IsString() rejectionReason?: string;
}

@Injectable()
export class ApplicationsService {
  private readonly logger = new Logger(ApplicationsService.name);
  private get db() { return this.prisma as any; }

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  async submit(userId: string, dto: SubmitApplicationDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === Role.INSTRUCTOR) {
      throw new BadRequestException('You are already an instructor');
    }
    if (user.role === Role.ADMIN || user.role === Role.SUPER_ADMIN) {
      throw new BadRequestException('Admins cannot apply as instructors');
    }

    const existing = await this.db.instructorApplication.findUnique({ where: { userId } });
    if (existing) {
      if (existing.status === 'pending') {
        throw new ConflictException('You already have a pending application');
      }
      if (existing.status === 'approved') {
        throw new ConflictException('Your application was already approved');
      }
      // Allow resubmission after rejection
      return this.db.instructorApplication.update({
        where: { userId },
        data: {
          motivation:         dto.motivation,
          teachingExperience: dto.teachingExperience,
          subjectExpertise:   dto.subjectExpertise,
          sampleContentUrl:   dto.sampleContentUrl,
          linkedinUrl:        dto.linkedinUrl,
          status:             'pending',
          reviewedBy:         null,
          reviewedAt:         null,
          rejectionReason:    null,
        },
      });
    }

    return this.db.instructorApplication.create({
      data: {
        userId,
        motivation:         dto.motivation,
        teachingExperience: dto.teachingExperience,
        subjectExpertise:   dto.subjectExpertise,
        sampleContentUrl:   dto.sampleContentUrl,
        linkedinUrl:        dto.linkedinUrl,
      },
    });
  }

  async getMyApplication(userId: string) {
    const application = await this.db.instructorApplication.findUnique({ where: { userId } });
    if (!application) throw new NotFoundException('No application found');
    return application;
  }

  // ── Admin endpoints ───────────────────────────────────────────────────────

  async adminList(pagination: PaginationDto, status?: string) {
    const { page = 1, limit = 20, skip = 0 } = pagination;
    const where: any = {};
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      this.db.instructorApplication.findMany({
        where,
        skip,
        take:    limit,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, email: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.instructorApplication.count({ where }),
    ]);

    return { applications, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async review(adminId: string, applicationId: string, dto: ReviewApplicationDto) {
    const application = await this.db.instructorApplication.findUnique({
      where:   { id: applicationId },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
    });
    if (!application) throw new NotFoundException('Application not found');
    if (application.status !== 'pending') {
      throw new BadRequestException('Application already reviewed');
    }
    if (dto.decision === 'rejected' && !dto.rejectionReason) {
      throw new BadRequestException('Rejection reason is required');
    }

    const user = application.user as any;

    if (dto.decision === 'approved') {
      // Promote user to INSTRUCTOR role and create instructor profile
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: user.id },
          data: { role: Role.INSTRUCTOR },
        }),
        this.prisma.instructorProfile.upsert({
          where:  { userId: user.id },
          create: { userId: user.id },
          update: {},
        }),
      ]);

      this.notificationsService.createNotification({
        userId:    user.id,
        type:      'SYSTEM_ALERT' as any,
        title:     'Instructor Application Approved! 🎉',
        message:   'Congratulations! Your application has been approved. You can now create courses.',
        actionUrl: '/instructor/dashboard',
      }).catch(() => {});
    } else {
      this.notificationsService.createNotification({
        userId:  user.id,
        type:    'SYSTEM_ALERT' as any,
        title:   'Instructor Application Update',
        message: `Your application was not approved: ${dto.rejectionReason}`,
      }).catch(() => {});
    }

    const updated = await this.db.instructorApplication.update({
      where: { id: applicationId },
      data: {
        status:          dto.decision,
        reviewedBy:      adminId,
        reviewedAt:      new Date(),
        rejectionReason: dto.rejectionReason ?? null,
      },
    });

    this.logger.log(`Application ${applicationId} ${dto.decision} by admin ${adminId}`);
    return updated;
  }

  async getStats() {
    const [pending, approved, rejected] = await Promise.all([
      this.db.instructorApplication.count({ where: { status: 'pending' } }),
      this.db.instructorApplication.count({ where: { status: 'approved' } }),
      this.db.instructorApplication.count({ where: { status: 'rejected' } }),
    ]);
    return { pending, approved, rejected, total: pending + approved + rejected };
  }
}
