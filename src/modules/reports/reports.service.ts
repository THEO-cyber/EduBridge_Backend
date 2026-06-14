import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TARGET_TYPES = ['course', 'review', 'chat_message', 'user', 'discussion'] as const;
type TargetType = typeof TARGET_TYPES[number];

export class CreateReportDto {
  @ApiProperty({ enum: TARGET_TYPES })
  @IsIn(TARGET_TYPES) targetType!: TargetType;

  @ApiProperty() @IsString() targetId!: string;

  @ApiProperty({ description: 'Reason for report: spam, inappropriate, copyright, etc.' })
  @IsString() reason!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() details?: string;
}

export class ReviewReportDto {
  @ApiProperty({ enum: ['reviewed', 'dismissed', 'actioned'] })
  @IsIn(['reviewed', 'dismissed', 'actioned']) status!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() resolution?: string;
}

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);
  private get db() { return this.prisma as any; }

  constructor(private readonly prisma: PrismaService) {}

  async create(reporterId: string, dto: CreateReportDto) {
    const existing = await this.db.contentReport.findFirst({
      where: { reporterId, targetType: dto.targetType, targetId: dto.targetId, status: 'pending' },
    });
    if (existing) throw new BadRequestException('You have already reported this content');

    return this.db.contentReport.create({
      data: {
        reporterId,
        targetType: dto.targetType,
        targetId:   dto.targetId,
        reason:     dto.reason,
        details:    dto.details,
      },
    });
  }

  async getMyReports(userId: string, pagination: PaginationDto) {
    const { page = 1, limit = 20, skip = 0 } = pagination;

    const [reports, total] = await Promise.all([
      this.db.contentReport.findMany({
        where:   { reporterId: userId },
        skip,
        take:    limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.db.contentReport.count({ where: { reporterId: userId } }),
    ]);

    return { reports, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ── Admin endpoints ───────────────────────────────────────────────────────

  async adminList(pagination: PaginationDto, status?: string, targetType?: string) {
    const { page = 1, limit = 20, skip = 0 } = pagination;
    const where: any = {};
    if (status)     where.status     = status;
    if (targetType) where.targetType = targetType;

    const [reports, total] = await Promise.all([
      this.db.contentReport.findMany({
        where,
        skip,
        take:    limit,
        include: { reporter: { select: { id: true, firstName: true, lastName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.contentReport.count({ where }),
    ]);

    return { reports, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async adminReview(adminId: string, reportId: string, dto: ReviewReportDto) {
    const report = await this.db.contentReport.findUnique({ where: { id: reportId } });
    if (!report) throw new NotFoundException('Report not found');

    return this.db.contentReport.update({
      where: { id: reportId },
      data: {
        status:     dto.status,
        resolution: dto.resolution,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      },
    });
  }

  async getStats() {
    const [pending, reviewed, actioned, total] = await Promise.all([
      this.db.contentReport.count({ where: { status: 'pending' } }),
      this.db.contentReport.count({ where: { status: 'reviewed' } }),
      this.db.contentReport.count({ where: { status: 'actioned' } }),
      this.db.contentReport.count(),
    ]);
    return { pending, reviewed, actioned, total };
  }
}
