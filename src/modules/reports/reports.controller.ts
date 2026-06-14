import {
  Controller, Post, Get, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReportsService, CreateReportDto, ReviewReportDto } from './reports.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role, User } from '@prisma/client';

@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  @ApiOperation({ summary: 'Report a piece of content' })
  create(@CurrentUser() user: User, @Body() dto: CreateReportDto) {
    return this.reportsService.create(user.id, dto);
  }

  @Get('my')
  @ApiOperation({ summary: 'Get my submitted reports' })
  getMyReports(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    return this.reportsService.getMyReports(user.id, pagination);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all reports (Admin)' })
  @ApiQuery({ name: 'status',     required: false })
  @ApiQuery({ name: 'targetType', required: false })
  adminList(
    @Query() pagination: PaginationDto,
    @Query('status') status?: string,
    @Query('targetType') targetType?: string,
  ) {
    return this.reportsService.adminList(pagination, status, targetType);
  }

  @Get('stats')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get report statistics (Admin)' })
  getStats() {
    return this.reportsService.getStats();
  }

  @Patch(':id/review')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Review/resolve a report (Admin)' })
  review(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: ReviewReportDto,
  ) {
    return this.reportsService.adminReview(user.id, id, dto);
  }
}
