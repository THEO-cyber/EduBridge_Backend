import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { IsString, IsIn, IsOptional, IsArray, ArrayNotEmpty, IsNumber, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { AdminService } from './admin.service';
import { SystemSettingsService } from './system-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CreateUserDto,
  UpdateUserDto,
  UserFiltersDto,
  CourseFiltersDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  RejectCourseDto,
  SuspendCourseDto,
} from './dto/admin.dto';
import { CreateSystemSettingDto, UpdateSystemSettingDto } from './dto/system-settings.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

class BroadcastNotificationDto {
  @IsIn(['STUDENT', 'INSTRUCTOR', 'ADMIN', 'ALL'])
  role!: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN' | 'ALL';

  @IsString()
  title!: string;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  actionUrl?: string;
}

class NotifyUserDto {
  @IsString()
  title!: string;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  actionUrl?: string;
}

class NotifyUsersDto {
  @IsArray()
  @ArrayNotEmpty()
  userIds!: string[];

  @IsString()
  title!: string;

  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  actionUrl?: string;
}

class UpdateNotificationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  actionUrl?: string;
}

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly systemSettingsService: SystemSettingsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // User Management
  @Get('users')
  @ApiOperation({ summary: 'Get all users with filters and pagination' })
  async getUsers(
    @Query() paginationDto: PaginationDto,
    @Query() filters: UserFiltersDto,
  ) {
    const parsedFilters: {
      role?: any;
      isActive?: boolean;
      search?: string;
      createdAfter?: Date;
      createdBefore?: Date;
    } = {
      role: filters.role,
      isActive: filters.isActive,
      search: filters.search,
      createdAfter: filters.createdAfter
        ? typeof filters.createdAfter === 'string'
          ? new Date(filters.createdAfter)
          : filters.createdAfter
        : undefined,
      createdBefore: filters.createdBefore
        ? typeof filters.createdBefore === 'string'
          ? new Date(filters.createdBefore)
          : filters.createdBefore
        : undefined,
    };

    return this.adminService.getUsers(paginationDto, parsedFilters);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get user by ID' })
  async getUserById(@Param('id') userId: string) {
    return this.adminService.getUserById(userId);
  }

  @Post('users')
  @ApiOperation({ summary: 'Create new user' })
  async createUser(@Body() createUserDto: CreateUserDto) {
    return this.adminService.createUser(createUserDto);
  }

  @Put('users/:id')
  @ApiOperation({ summary: 'Update user' })
  async updateUser(
    @Param('id') userId: string,
    @Body() updateUserDto: UpdateUserDto,
  ) {
    return this.adminService.updateUser(userId, updateUserDto);
  }

  @Put('users/:id/deactivate')
  @ApiOperation({ summary: 'Deactivate user' })
  async deactivateUser(@Param('id') userId: string) {
    return this.adminService.deactivateUser(userId);
  }

  @Delete('users/:id')
  @ApiOperation({ summary: 'Delete user' })
  async deleteUser(@Param('id') userId: string) {
    return this.adminService.deleteUser(userId);
  }

  // Course Management
  @Get('courses')
  @ApiOperation({ summary: 'Get all courses with filters and pagination' })
  async getCourses(
    @Query() paginationDto: PaginationDto,
    @Query() filters: CourseFiltersDto,
  ) {
    const parsedFilters: {
      status?: any;
      instructorId?: string;
      categoryId?: string;
      search?: string;
      createdAfter?: Date;
      createdBefore?: Date;
    } = {
      status: filters.status,
      instructorId: filters.instructorId,
      categoryId: filters.categoryId,
      search: filters.search,
      createdAfter: filters.createdAfter
        ? typeof filters.createdAfter === 'string'
          ? new Date(filters.createdAfter)
          : filters.createdAfter
        : undefined,
      createdBefore: filters.createdBefore
        ? typeof filters.createdBefore === 'string'
          ? new Date(filters.createdBefore)
          : filters.createdBefore
        : undefined,
    };

    return this.adminService.getCourses(paginationDto, parsedFilters);
  }

  @Get('courses/pending')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all courses awaiting review (Super Admin only)' })
  async getPendingCourses(@Query() paginationDto: PaginationDto) {
    return this.adminService.getPendingCourses(paginationDto);
  }

  // Must come AFTER static routes (courses/pending) so NestJS doesn't shadow them
  @Get('courses/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get full course detail for review (Super Admin only)' })
  async getCourseForReview(@Param('id') courseId: string) {
    return this.adminService.getCourseForReview(courseId);
  }

  @Put('courses/:id/approve')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve course — makes it live (Super Admin only)' })
  async approveCourse(@Param('id') courseId: string) {
    return this.adminService.approveCourse(courseId);
  }

  @Put('courses/:id/reject')
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Reject and permanently delete a course — notifies instructor with reason (Super Admin only)' })
  async rejectCourse(
    @Param('id') courseId: string,
    @Body() rejectCourseDto: RejectCourseDto,
  ) {
    return this.adminService.rejectCourse(courseId, rejectCourseDto.reason);
  }

  @Put('courses/:id/suspend')
  @ApiOperation({ summary: 'Suspend course' })
  async suspendCourse(
    @Param('id') courseId: string,
    @Body() suspendCourseDto: SuspendCourseDto,
  ) {
    return this.adminService.suspendCourse(courseId, suspendCourseDto.reason);
  }

  // Category Management
  @Post('categories')
  @ApiOperation({ summary: 'Create new category' })
  async createCategory(@Body() createCategoryDto: CreateCategoryDto) {
    return this.adminService.createCategory(
      createCategoryDto.name,
      createCategoryDto.description,
    );
  }

  @Put('categories/:id')
  @ApiOperation({ summary: 'Update category' })
  async updateCategory(
    @Param('id') categoryId: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ) {
    return this.adminService.updateCategory(
      categoryId,
      updateCategoryDto.name,
      updateCategoryDto.description,
    );
  }

  @Delete('categories/:id')
  @ApiOperation({ summary: 'Delete category' })
  async deleteCategory(@Param('id') categoryId: string) {
    return this.adminService.deleteCategory(categoryId);
  }

  // Statistics and Analytics
  @Get('dashboard/stats')
  @ApiOperation({ summary: 'Get system statistics' })
  async getSystemStats() {
    return this.adminService.getSystemStats();
  }

  @Get('dashboard/activity')
  @ApiOperation({ summary: 'Get recent platform activity' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getRecentActivity(
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.adminService.getRecentActivity(limit || 50);
  }

  // ── System Settings (SUPER_ADMIN only) ───────────────────────────────────

  @Get('settings')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List all system settings (Super Admin only)' })
  async listSettings() {
    return this.systemSettingsService.listAll();
  }

  @Get('settings/:key')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Get system setting by key (Super Admin only)' })
  async getSetting(@Param('key') key: string) {
    return this.systemSettingsService.getByKey(key);
  }

  @Post('settings')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Create system setting (Super Admin only)' })
  async createSetting(@Body() dto: CreateSystemSettingDto) {
    return this.systemSettingsService.create(dto);
  }

  @Put('settings/:key')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Update system setting (Super Admin only)' })
  async updateSetting(@Param('key') key: string, @Body() dto: UpdateSystemSettingDto) {
    return this.systemSettingsService.update(key, dto);
  }

  @Delete('settings/:key')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Delete system setting (Super Admin only)' })
  async deleteSetting(@Param('key') key: string) {
    return this.systemSettingsService.delete(key);
  }

  @Patch('settings/bulk')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Bulk upsert system settings (Super Admin only)' })
  async bulkUpsertSettings(@Body() settings: Array<{ key: string; value: string }>) {
    return this.systemSettingsService.bulkUpsert(settings);
  }

  // ── Super Admin: promote/demote admins ───────────────────────────────────

  @Put('users/:id/role')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Change user role (Super Admin only)' })
  async changeUserRole(@Param('id') userId: string, @Body('role') role: Role) {
    return this.adminService.changeUserRole(userId, role);
  }

  @Put('users/:id/activate')
  @ApiOperation({ summary: 'Activate/reactivate a user account' })
  async activateUser(@Param('id') userId: string) {
    return this.adminService.activateUser(userId);
  }

  // ── Categories: full list (public browsing) ───────────────────────────────

  @Get('categories')
  @ApiOperation({ summary: 'List all categories (admin view with inactive)' })
  async listCategories() {
    return this.adminService.listCategories();
  }

  // ── Admin Notifications ────────────────────────────────────────────────────

  @Post('notifications/broadcast')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({
    summary: 'Broadcast push notification to a role group',
    description: 'role: STUDENT | INSTRUCTOR | ADMIN | ALL',
  })
  async broadcastNotification(@Body() dto: BroadcastNotificationDto) {
    return this.notificationsService.broadcastToRole(
      dto.role,
      dto.title,
      dto.message,
      undefined,
      dto.actionUrl,
    );
  }

  @Post('notifications/user/:id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Send push notification to a specific user' })
  async notifyOneUser(@Param('id') userId: string, @Body() dto: NotifyUserDto) {
    return this.notificationsService.broadcastToUsers(
      [userId],
      dto.title,
      dto.message,
      undefined,
      dto.actionUrl,
    );
  }

  @Post('notifications/users')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Send push notification to a selected group of users' })
  async notifyMultipleUsers(@Body() dto: NotifyUsersDto) {
    return this.notificationsService.broadcastToUsers(
      dto.userIds,
      dto.title,
      dto.message,
      undefined,
      dto.actionUrl,
    );
  }

  @Get('notifications')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'List all notifications (admin view)' })
  async listNotifications(@Query() paginationDto: PaginationDto) {
    return this.adminService.listNotifications(paginationDto);
  }

  @Patch('notifications/:id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Update a notification title/message/actionUrl' })
  async updateNotification(
    @Param('id') id: string,
    @Body() dto: UpdateNotificationDto,
  ) {
    return this.adminService.updateNotification(id, dto);
  }

  @Delete('notifications/:id')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Delete a notification' })
  async deleteNotification(@Param('id') id: string) {
    return this.adminService.deleteNotification(id);
  }

  // ── Instructor moderation (Super Admin only) ──────────────────────────────

  @Post('instructors/:id/suspend')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Suspend an instructor account (Super Admin only)' })
  async suspendInstructor(
    @Param('id') instructorId: string,
    @Body('reason') reason: string,
  ) {
    return this.adminService.suspendInstructor(instructorId, reason);
  }

  @Post('instructors/:id/warn')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Send a formal warning to an instructor (Super Admin only)' })
  async warnInstructor(
    @Param('id') instructorId: string,
    @Body('message') message: string,
  ) {
    return this.adminService.warnInstructor(instructorId, message);
  }

  @Delete('instructors/:id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Delete (deactivate) an instructor and archive their courses (Super Admin only)',
  })
  async deleteInstructor(@Param('id') instructorId: string) {
    return this.adminService.deleteInstructor(instructorId);
  }

  // ── Reviews (Super Admin / Admin visibility) ──────────────────────────────

  // ── Video moderation (Super Admin only) ──────────────────────────────────

  @Get('videos/pending')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List videos awaiting superadmin review (Super Admin only)' })
  async getPendingVideos(@Query() paginationDto: PaginationDto) {
    return this.adminService.getPendingVideos(paginationDto);
  }

  @Post('videos/:id/approve')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Approve a video — makes it live for students (Super Admin only)' })
  async approveVideo(@Param('id') videoId: string) {
    return this.adminService.approveVideo(videoId);
  }

  @Post('videos/:id/reject')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'Reject and delete a video — notifies instructor with reason (Super Admin only)' })
  async rejectVideo(
    @Param('id') videoId: string,
    @Body('reason') reason: string,
  ) {
    if (!reason?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }
    return this.adminService.rejectVideo(videoId, reason);
  }

  @Get('videos/:id/preview-url')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'Get a short-lived preview URL for any video regardless of status (Admin only)' })
  @ApiQuery({ name: 'quality', required: false, enum: ['360p', '480p', '720p', '1080p'] })
  async getVideoPreviewUrl(
    @Param('id') videoId: string,
    @Query('quality') quality = '720p',
  ) {
    return this.adminService.getVideoPreviewUrl(videoId, quality);
  }

  // ── Reviews (Super Admin / Admin visibility) ──────────────────────────────

  @Get('reviews')
  @Roles(Role.SUPER_ADMIN, Role.ADMIN)
  @ApiOperation({ summary: 'List all platform reviews with filters (Admin only)' })
  @ApiQuery({ name: 'courseId',      required: false })
  @ApiQuery({ name: 'instructorId',  required: false })
  @ApiQuery({ name: 'rating',        required: false, type: Number })
  async getAllReviews(
    @Query() paginationDto: PaginationDto,
    @Query('courseId')     courseId?: string,
    @Query('instructorId') instructorId?: string,
    @Query('rating')       rating?: string,
  ) {
    return this.adminService.getAllReviews(paginationDto, {
      courseId,
      instructorId,
      rating: rating ? parseInt(rating, 10) : undefined,
    });
  }
}
