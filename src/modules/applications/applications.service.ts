import {
  Injectable, NotFoundException, BadRequestException,
  ConflictException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../../common/email/email.service';
import { ConfigService } from '@nestjs/config';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  IsString, IsOptional, IsArray, IsIn, IsEmail, MinLength, MaxLength, Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

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

/**
 * Public (no-account) instructor application. The applicant provides both their
 * account details and their teaching credentials; the user account is created
 * only if an admin approves — so unapproved applicants never occupy a user row.
 */
export class PublicInstructorApplyDto {
  @ApiProperty({ example: 'jane@example.com' })
  @IsEmail() email!: string;

  @ApiProperty({ example: 'Jane' })
  @IsString() @MinLength(2) firstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString() @MinLength(2) lastName!: string;

  @ApiProperty({ description: 'Min 8 chars, upper, lower, number, special' })
  @IsString() @MinLength(8) @MaxLength(64)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).+$/, {
    message: 'Password must contain at least one uppercase letter, one lowercase letter, one number, and one special character',
  })
  password!: string;

  @ApiProperty({ description: 'Why do you want to teach on EduBridge?' })
  @IsString() motivation!: string;

  @ApiProperty({ description: 'List of subjects/topics you will teach', type: [String] })
  @IsArray() @IsString({ each: true }) subjectExpertise!: string[];

  @ApiPropertyOptional() @IsOptional() @IsString() teachingExperience?: string;
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
    private readonly configService: ConfigService,
  ) {}

  private get frontendUrl(): string {
    const raw = this.configService.get<string>('frontendUrl') ?? '';
    const first = raw.split(',').map((s) => s.trim()).filter(Boolean)[0];
    return first || 'https://edubridge-web.netlify.app';
  }

  private async generateUniqueUsername(email: string): Promise<string> {
    const base = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_]/g, '') || 'user';
    for (let i = 0; i < 6; i++) {
      const candidate = `${base}${1000 + Math.floor(Math.random() * 9000)}`;
      const exists = await this.prisma.user.findUnique({ where: { username: candidate } });
      if (!exists) return candidate;
    }
    return `${base}${Date.now()}`;
  }

  /**
   * Public apply: store the application (with a hashed password) but do NOT
   * create a user account. The account is provisioned only on approval.
   */
  async applyPublic(dto: PublicInstructorApplyDto) {
    const email = dto.email.toLowerCase().trim();

    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new ConflictException(
        'An account with this email already exists. Please log in and apply from your dashboard.',
      );
    }

    const existing = await this.db.instructorApplication.findFirst({
      where: { email, status: { in: ['pending', 'approved'] } },
    });
    if (existing) {
      throw new ConflictException(
        existing.status === 'approved'
          ? 'An application for this email was already approved. Please log in.'
          : "You already have a pending application. We'll email you once it's reviewed.",
      );
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const app = await this.db.instructorApplication.create({
      data: {
        email,
        firstName: dto.firstName.trim(),
        lastName: dto.lastName.trim(),
        passwordHash,
        motivation: dto.motivation,
        teachingExperience: dto.teachingExperience,
        subjectExpertise: dto.subjectExpertise,
        sampleContentUrl: dto.sampleContentUrl,
        linkedinUrl: dto.linkedinUrl,
      },
    });

    // Never return the password hash.
    return { id: app.id, status: app.status, email: app.email, createdAt: app.createdAt };
  }

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

    const existingUser = application.user as any;
    // Details for notifications/emails, from either the linked user or the
    // applicant fields captured on a public (pre-account) application.
    const name = (existingUser?.firstName ?? application.firstName ?? 'there') as string;
    const email = (existingUser?.email ?? application.email) as string | undefined;

    if (dto.decision === 'approved') {
      let userId = existingUser?.id as string | undefined;

      if (userId) {
        // Existing account → just promote it.
        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: userId },
            data: { role: Role.INSTRUCTOR },
          }),
          this.prisma.instructorProfile.upsert({
            where:  { userId },
            create: { userId },
            update: {},
          }),
        ]);
      } else {
        // Public application → create the account NOW, at approval time.
        if (!application.email || !application.passwordHash) {
          throw new BadRequestException('Application is missing account details');
        }
        const clash = await this.prisma.user.findUnique({ where: { email: application.email } });
        if (clash) {
          throw new ConflictException('An account with this email already exists');
        }
        const username = await this.generateUniqueUsername(application.email);
        const created = await this.prisma.user.create({
          data: {
            email:           application.email,
            username,
            firstName:       application.firstName ?? 'Instructor',
            lastName:        application.lastName ?? '',
            role:            Role.INSTRUCTOR,
            isEmailVerified: true,
            userAuth:          { create: { passwordHash: application.passwordHash } },
            instructorProfile: { create: {} },
          },
        });
        userId = created.id;
      }

      // Link the application to the account and drop the stored password hash.
      const updated = await this.db.instructorApplication.update({
        where: { id: applicationId },
        data: {
          status:          'approved',
          reviewedBy:      adminId,
          reviewedAt:      new Date(),
          rejectionReason: null,
          userId,
          passwordHash:    null,
        },
      });

      this.notificationsService.createNotification({
        userId,
        type:      'SYSTEM_ALERT' as any,
        title:     'Instructor Application Approved! 🎉',
        message:   'Congratulations! Your application has been approved. You can now create courses.',
        actionUrl: '/instructor/dashboard',
      }).catch(() => {});
      if (email) {
        this.emailService.sendInstructorApplicationApproved(email, name, this.frontendUrl).catch(() => {});
      }

      this.logger.log(`Application ${applicationId} approved by admin ${adminId}`);
      return updated;
    }

    // Rejected — no account is created. Notify in-app if a user exists, else email.
    const updated = await this.db.instructorApplication.update({
      where: { id: applicationId },
      data: {
        status:          'rejected',
        reviewedBy:      adminId,
        reviewedAt:      new Date(),
        rejectionReason: dto.rejectionReason ?? null,
      },
    });

    if (existingUser?.id) {
      this.notificationsService.createNotification({
        userId:  existingUser.id,
        type:    'SYSTEM_ALERT' as any,
        title:   'Instructor Application Update',
        message: `Your application was not approved: ${dto.rejectionReason}`,
      }).catch(() => {});
    }
    if (email) {
      this.emailService.sendInstructorApplicationRejected(email, name, dto.rejectionReason ?? '').catch(() => {});
    }

    this.logger.log(`Application ${applicationId} rejected by admin ${adminId}`);
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
