import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  LessonsService, CreateSectionDto, UpdateSectionDto,
  CreateLessonDto, UpdateLessonDto, ReorderDto,
} from './lessons.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role, User } from '@prisma/client';

@ApiTags('Lessons')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('lessons')
export class LessonsController {
  constructor(private readonly lessonsService: LessonsService) {}

  // ─── Sections ──────────────────────────────────────────────────────────────

  @Post('sections/:courseId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Create a section in a course (instructor only)' })
  createSection(
    @Param('courseId') courseId: string,
    @Body() dto: CreateSectionDto,
    @CurrentUser() user: User,
  ) {
    return this.lessonsService.createSection(courseId, user.id, dto);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get('sections/:courseId')
  @ApiOperation({ summary: 'List all sections for a course (instructor sees draft sections; others see published only)' })
  getSections(@Param('courseId') courseId: string, @CurrentUser() user?: User) {
    return this.lessonsService.getSections(courseId, user?.id);
  }

  @Patch('sections/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Update a section' })
  updateSection(
    @Param('id') id: string,
    @Body() dto: UpdateSectionDto,
    @CurrentUser() user: User,
  ) {
    return this.lessonsService.updateSection(id, user.id, dto);
  }

  @Delete('sections/:id')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Delete a section and all its lessons' })
  deleteSection(@Param('id') id: string, @CurrentUser() user: User) {
    return this.lessonsService.deleteSection(id, user.id);
  }

  @Patch('sections/reorder/:courseId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Reorder sections by passing an ordered array of IDs' })
  reorderSections(
    @Param('courseId') courseId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: User,
  ) {
    return this.lessonsService.reorderSections(courseId, user.id, dto);
  }

  // ─── Lessons ───────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Create a lesson in a section (instructor only)' })
  createLesson(@Body() dto: CreateLessonDto, @CurrentUser() user: User) {
    return this.lessonsService.createLesson(user.id, dto);
  }

  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get lesson details (preview lessons are public; others require enrollment)' })
  getLesson(@Param('id') id: string, @CurrentUser() user?: User) {
    return this.lessonsService.getLesson(id, user?.id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Update a lesson' })
  updateLesson(
    @Param('id') id: string,
    @Body() dto: UpdateLessonDto,
    @CurrentUser() user: User,
  ) {
    return this.lessonsService.updateLesson(id, user.id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Delete a lesson' })
  deleteLesson(@Param('id') id: string, @CurrentUser() user: User) {
    return this.lessonsService.deleteLesson(id, user.id);
  }

  @Patch('reorder/:sectionId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Reorder lessons in a section' })
  reorderLessons(
    @Param('sectionId') sectionId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: User,
  ) {
    return this.lessonsService.reorderLessons(sectionId, user.id, dto);
  }
}
