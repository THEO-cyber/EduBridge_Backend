import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, User } from '@prisma/client';
import { IsOptional, IsDateString, IsEnum } from 'class-validator';
import { Type, Transform } from 'class-transformer';

class DateRangeQueryDto {
  @IsOptional()
  @IsDateString()
  @Transform(({ value }) => (value ? new Date(value) : undefined))
  startDate?: Date;

  @IsOptional()
  @IsDateString()
  @Transform(({ value }) => (value ? new Date(value) : undefined))
  endDate?: Date;
}

class TrendsQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsEnum(['day', 'week', 'month'])
  interval?: 'day' | 'week' | 'month';
}

@ApiTags('Analytics')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Get('platform/overview')
  @ApiOperation({ summary: 'Get platform overview analytics (Admin only)' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getPlatformOverview(@Query() dateRangeQuery: DateRangeQueryDto) {
    const dateRange =
      dateRangeQuery.startDate && dateRangeQuery.endDate
        ? {
            startDate: dateRangeQuery.startDate,
            endDate: dateRangeQuery.endDate,
          }
        : undefined;

    return this.analyticsService.getPlatformOverview(dateRange);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Get('platform/enrollment-trends')
  @ApiOperation({ summary: 'Get enrollment trends (Admin only)' })
  @ApiQuery({ name: 'startDate', required: true, type: String })
  @ApiQuery({ name: 'endDate', required: true, type: String })
  @ApiQuery({
    name: 'interval',
    required: false,
    enum: ['day', 'week', 'month'],
  })
  async getEnrollmentTrends(@Query() trendsQuery: TrendsQueryDto) {
    if (!trendsQuery.startDate || !trendsQuery.endDate) {
      throw new Error('Start date and end date are required');
    }

    const dateRange = {
      startDate: trendsQuery.startDate,
      endDate: trendsQuery.endDate,
    };

    return this.analyticsService.getEnrollmentTrends(
      dateRange,
      trendsQuery.interval || 'day',
    );
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Get('platform/categories')
  @ApiOperation({ summary: 'Get category analytics (Admin only)' })
  async getCategoryAnalytics() {
    return this.analyticsService.getCategoryAnalytics();
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Get('platform/top-instructors')
  @ApiOperation({ summary: 'Get top instructors analytics (Admin only)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTopInstructors(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.analyticsService.getTopInstructors(limit || 10);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Get('instructor/dashboard')
  @ApiOperation({
    summary: 'Get instructor analytics dashboard (Instructor only)',
  })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getInstructorAnalytics(
    @CurrentUser() user: User,
    @Query() dateRangeQuery: DateRangeQueryDto,
  ) {
    const dateRange =
      dateRangeQuery.startDate && dateRangeQuery.endDate
        ? {
            startDate: dateRangeQuery.startDate,
            endDate: dateRangeQuery.endDate,
          }
        : undefined;

    return this.analyticsService.getInstructorAnalytics(user.id, dateRange);
  }

  @Get('course/:courseId')
  @ApiOperation({ summary: 'Get course analytics' })
  async getCourseAnalytics(
    @Param('courseId') courseId: string,
    @CurrentUser() user: User,
  ) {
    return this.analyticsService.getCourseAnalytics(
      courseId,
      user.id,
      user.role,
    );
  }

  @UseGuards(RolesGuard)
  @Roles(Role.STUDENT)
  @Get('student/progress')
  @ApiOperation({ summary: 'Get student progress analytics (Student only)' })
  async getStudentProgress(@CurrentUser() user: User) {
    return this.analyticsService.getStudentProgress(user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR, Role.ADMIN)
  @Get('instructor/:instructorId/dashboard')
  @ApiOperation({ summary: 'Get specific instructor analytics (Admin only)' })
  @ApiQuery({ name: 'startDate', required: false, type: String })
  @ApiQuery({ name: 'endDate', required: false, type: String })
  async getSpecificInstructorAnalytics(
    @Param('instructorId') instructorId: string,
    @Query() dateRangeQuery: DateRangeQueryDto,
    @CurrentUser() user: User,
  ) {
    // Admins can view any instructor's analytics
    // Instructors can only view their own analytics
    if (user.role === Role.INSTRUCTOR && user.id !== instructorId) {
      throw new Error('Instructors can only view their own analytics');
    }

    const dateRange =
      dateRangeQuery.startDate && dateRangeQuery.endDate
        ? {
            startDate: dateRangeQuery.startDate,
            endDate: dateRangeQuery.endDate,
          }
        : undefined;

    return this.analyticsService.getInstructorAnalytics(
      instructorId,
      dateRange,
    );
  }
}
