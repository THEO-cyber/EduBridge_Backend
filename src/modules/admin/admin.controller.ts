import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
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
import { AdminService } from './admin.service';
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
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

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

  @Put('courses/:id/approve')
  @ApiOperation({ summary: 'Approve course' })
  async approveCourse(@Param('id') courseId: string) {
    return this.adminService.approveCourse(courseId);
  }

  @Put('courses/:id/reject')
  @ApiOperation({ summary: 'Reject course' })
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
}
