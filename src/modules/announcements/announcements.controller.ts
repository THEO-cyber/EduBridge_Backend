import {
  Controller, Post, Get, Patch, Delete,
  Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AnnouncementsService, CreateAnnouncementDto, UpdateAnnouncementDto } from './announcements.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role, User } from '@prisma/client';

@ApiTags('Announcements')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcementsService: AnnouncementsService) {}

  @Post('courses/:courseId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Create course announcement (Instructor only)' })
  create(
    @Param('courseId') courseId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateAnnouncementDto,
  ) {
    return this.announcementsService.create(user.id, courseId, dto);
  }

  @Get('courses/:courseId')
  @ApiOperation({ summary: 'Get announcements for an enrolled course' })
  getForCourse(
    @Param('courseId') courseId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.announcementsService.getCourseAnnouncements(courseId, pagination, user.id);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Update announcement (Instructor only)' })
  update(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    return this.announcementsService.update(user.id, id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Delete announcement (Instructor only)' })
  delete(@Param('id') id: string, @CurrentUser() user: User) {
    return this.announcementsService.delete(user.id, id);
  }
}
