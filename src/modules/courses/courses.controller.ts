import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiParam,
} from '@nestjs/swagger';
import { CoursesService } from './courses.service';
import { CreateCourseDto } from './dto/create-course.dto';
import { UpdateCourseDto } from './dto/update-course.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CourseStatus, CourseLevel, Role, User } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsOptional, IsEnum, IsString, IsNumber } from 'class-validator';

class CourseFiltersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;

  @IsOptional()
  @IsEnum(CourseLevel)
  level?: CourseLevel;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  instructorId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  minPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  maxPrice?: number;
}

@ApiTags('Courses')
@Controller('courses')
export class CoursesController {
  constructor(private readonly coursesService: CoursesService) {}

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post()
  @ApiOperation({ summary: 'Create a new course (Instructor only)' })
  async create(
    @CurrentUser() user: User,
    @Body() createCourseDto: CreateCourseDto,
  ) {
    return this.coursesService.create(user.id, createCourseDto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Get all published courses' })
  @ApiQuery({ name: 'status', required: false, enum: CourseStatus })
  @ApiQuery({ name: 'level', required: false, enum: CourseLevel })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'instructorId', required: false })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'minPrice', required: false })
  @ApiQuery({ name: 'maxPrice', required: false })
  async findAll(@Query() filters: CourseFiltersDto) {
    const {
      page,
      limit,
      status,
      level,
      categoryId,
      instructorId,
      search,
      minPrice,
      maxPrice,
    } = filters;
    const paginationDto = new PaginationDto();
    paginationDto.page = page;
    paginationDto.limit = limit;
    const filterOptions = {
      status,
      level,
      categoryId,
      instructorId,
      search,
      minPrice,
      maxPrice,
    };

    return this.coursesService.findAll(paginationDto, filterOptions);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Get('instructor/my-courses')
  @ApiOperation({ summary: "Get instructor's courses" })
  async getInstructorCourses(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.coursesService.getInstructorCourses(user.id, paginationDto);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get course by slug' })
  @ApiParam({ name: 'slug', description: 'Course slug' })
  async findBySlug(@Param('slug') slug: string, @CurrentUser() user?: User) {
    return this.coursesService.findBySlug(slug, user?.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get course by ID' })
  async findOne(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.coursesService.findOne(id, user?.id);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Patch(':id')
  @ApiOperation({ summary: 'Update course (Instructor only)' })
  async update(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() updateCourseDto: UpdateCourseDto,
  ) {
    return this.coursesService.update(id, user.id, updateCourseDto);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post(':id/publish')
  @ApiOperation({ summary: 'Submit course for review (Instructor only)' })
  async publish(@Param('id') id: string, @CurrentUser() user: User) {
    return this.coursesService.publish(id, user.id);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete course (Instructor only)' })
  async remove(@Param('id') id: string, @CurrentUser() user: User) {
    return this.coursesService.remove(id, user.id);
  }
}
