import {
  Controller,
  Post,
  Get,
  Patch,
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
import { LiveSessionsService } from './live-sessions.service';
import { CreateLiveSessionDto, UpdateLiveSessionDto, NotifySessionDto } from './dto/live-session.dto';
import { AvailabilityService } from './availability.service';
import { CreateSessionRequestDto } from './dto/session-request.dto';
import { CreateAvailabilitySlotDto, UpdateAvailabilitySlotDto } from './dto/availability.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, User, SessionStatus } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

class EndSessionDto {
  @IsOptional()
  @IsString()
  meetingNotes?: string;
}

class ApplyToSessionDto {
  @ApiPropertyOptional({ example: 'I have been studying this topic for 2 months and would love to join.' })
  @IsOptional()
  @IsString()
  message?: string;
}

@ApiTags('Live Sessions')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('live-sessions')
export class LiveSessionsController {
  constructor(
    private readonly liveSessionsService: LiveSessionsService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  // ── Group Live Sessions (Instructor-led) ───────────────────────────────────

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post()
  @ApiOperation({ summary: 'Create a group live session (Instructor only)' })
  async createLiveSession(
    @CurrentUser() user: User,
    @Body() dto: CreateLiveSessionDto,
  ) {
    return this.liveSessionsService.createLiveSession(user.id, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Browse upcoming public live sessions (alias for /upcoming)' })
  @ApiQuery({ name: 'instructorId', required: false })
  @ApiQuery({ name: 'courseId', required: false })
  async listLiveSessions(
    @Query() pagination: PaginationDto,
    @Query('instructorId') instructorId?: string,
    @Query('courseId') courseId?: string,
  ) {
    return this.liveSessionsService.browseUpcomingSessions(pagination, { instructorId, courseId });
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Browse upcoming public live sessions' })
  @ApiQuery({ name: 'instructorId', required: false })
  @ApiQuery({ name: 'courseId', required: false })
  async browseUpcomingSessions(
    @Query() pagination: PaginationDto,
    @Query('instructorId') instructorId?: string,
    @Query('courseId') courseId?: string,
  ) {
    return this.liveSessionsService.browseUpcomingSessions(pagination, { instructorId, courseId });
  }

  @Get('instructor/:instructorId')
  @ApiOperation({ summary: 'Get all live sessions created by an instructor' })
  async getInstructorSessions(
    @Param('instructorId') instructorId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.liveSessionsService.browseUpcomingSessions(pagination, { instructorId });
  }

  @Get('course/:courseId')
  @ApiOperation({ summary: 'Get live sessions for a specific course' })
  async getCourseSessions(
    @Param('courseId') courseId: string,
    @Query() pagination: PaginationDto,
  ) {
    return this.liveSessionsService.browseUpcomingSessions(pagination, { courseId });
  }

  @UseGuards(RolesGuard)
  @Roles(Role.STUDENT)
  @Post(':id/apply')
  @ApiOperation({ summary: 'Apply to a group live session (Student only)' })
  async applyToSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
    @Body() dto: ApplyToSessionDto,
  ) {
    return this.liveSessionsService.applyToSession(sessionId, user.id, dto.message);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Get(':id/applications')
  @ApiOperation({ summary: 'View all applicants for a session (Instructor only)' })
  async getSessionApplications(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.liveSessionsService.getSessionApplications(sessionId, user.id, pagination);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Patch('applications/:id/accept')
  @ApiOperation({ summary: 'Accept a student application (Instructor only)' })
  async acceptApplication(
    @Param('id') applicationId: string,
    @CurrentUser() user: User,
  ) {
    return this.liveSessionsService.acceptApplication(applicationId, user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Patch('applications/:id/reject')
  @ApiOperation({ summary: 'Reject a student application (Instructor only)' })
  async rejectApplication(
    @Param('id') applicationId: string,
    @CurrentUser() user: User,
  ) {
    return this.liveSessionsService.rejectApplication(applicationId, user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a live session (Instructor only)' })
  async updateLiveSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateLiveSessionDto,
  ) {
    return this.liveSessionsService.updateLiveSession(sessionId, user.id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete a live session (Instructor only, not in-progress or completed)' })
  async deleteLiveSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
  ) {
    return this.liveSessionsService.deleteLiveSession(sessionId, user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post(':id/notify-accepted')
  @ApiOperation({ summary: 'Send notification to all accepted students (Instructor only)' })
  async notifyAcceptedStudents(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
    @Body() dto: NotifySessionDto,
  ) {
    return this.liveSessionsService.notifyAcceptedStudents(sessionId, user.id, dto);
  }

  // ── Shared: join / end ─────────────────────────────────────────────────────

  @Post(':id/join')
  @ApiOperation({ summary: 'Join live session (accepted students + instructor)' })
  async joinSession(@Param('id') sessionId: string, @CurrentUser() user: User) {
    return this.liveSessionsService.joinSession(sessionId, user.id);
  }

  @Get(':id/reviews')
  @ApiOperation({ summary: 'Get post-session reviews for a session (Instructor + Admin only)' })
  async getSessionReviews(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
  ) {
    return this.liveSessionsService.getSessionReviews(sessionId, user.id);
  }

  @Patch(':id/end')
  @ApiOperation({ summary: 'End live session' })
  async endSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
    @Body() dto: EndSessionDto,
  ) {
    return this.liveSessionsService.endSession(sessionId, user.id, dto.meetingNotes);
  }

  // ── My Sessions ─────────────────────────────────────────────────────────────

  @Get('my-sessions')
  @ApiOperation({ summary: 'Get sessions for the current user' })
  @ApiQuery({ name: 'role', required: false, enum: ['instructor', 'student'] })
  async getUserSessions(
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
    @Query('role') role?: 'instructor' | 'student',
  ) {
    return this.liveSessionsService.getUserSessions(user.id, pagination, role);
  }

  // ── Legacy: 1-on-1 Student-initiated Requests ──────────────────────────────

  @UseGuards(RolesGuard)
  @Roles(Role.STUDENT)
  @Post('request')
  @ApiOperation({ summary: 'Request a private 1-on-1 live session (Student only)' })
  async createSessionRequest(
    @CurrentUser() user: User,
    @Body() dto: CreateSessionRequestDto,
  ) {
    return this.liveSessionsService.createSessionRequest(user.id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post('requests/:id/confirm')
  @ApiOperation({ summary: 'Confirm a 1-on-1 session request (Instructor only)' })
  async confirmSessionRequest(
    @Param('id') requestId: string,
    @CurrentUser() user: User,
  ) {
    return this.liveSessionsService.confirmSessionRequest(requestId, user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Get('requests')
  @ApiOperation({ summary: 'Get 1-on-1 session requests (Instructor only)' })
  @ApiQuery({ name: 'status', required: false, enum: SessionStatus })
  async getSessionRequests(
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
    @Query('status') status?: SessionStatus,
  ) {
    return this.liveSessionsService.getSessionRequests(user.id, pagination, status);
  }

  @Patch('requests/:id/cancel')
  @ApiOperation({ summary: 'Cancel a session request' })
  async cancelSessionRequest(@Param('id') requestId: string, @CurrentUser() user: User) {
    return this.liveSessionsService.cancelSessionRequest(requestId, user.id);
  }

  // ── Availability Slots ─────────────────────────────────────────────────────

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post('availability')
  @ApiOperation({ summary: 'Create availability slot (Instructor only)' })
  async createSlot(@CurrentUser() user: User, @Body() dto: CreateAvailabilitySlotDto) {
    return this.availabilityService.createSlot(user.id, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Get('availability/my-slots')
  @ApiOperation({ summary: 'Get my availability slots (Instructor only)' })
  async getMySlots(@CurrentUser() user: User) {
    return this.availabilityService.getMySlots(user.id);
  }

  @Get('availability/:instructorId')
  @ApiOperation({ summary: 'Get instructor availability (Students/public view)' })
  async getInstructorSlots(@Param('instructorId') instructorId: string) {
    return this.availabilityService.getInstructorSlots(instructorId);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Patch('availability/:id')
  @ApiOperation({ summary: 'Update availability slot (Instructor only)' })
  async updateSlot(
    @Param('id') slotId: string,
    @CurrentUser() user: User,
    @Body() dto: UpdateAvailabilitySlotDto,
  ) {
    return this.availabilityService.updateSlot(user.id, slotId, dto);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Delete('availability/:id')
  @ApiOperation({ summary: 'Delete availability slot (Instructor only)' })
  async deleteSlot(@Param('id') slotId: string, @CurrentUser() user: User) {
    return this.availabilityService.deleteSlot(user.id, slotId);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Put('availability/day/:dayOfWeek')
  @ApiOperation({ summary: 'Replace all slots for a day (Instructor only)' })
  async replaceDaySlots(
    @Param('dayOfWeek', ParseIntPipe) dayOfWeek: number,
    @CurrentUser() user: User,
    @Body() slots: CreateAvailabilitySlotDto[],
  ) {
    return this.availabilityService.replaceDaySlots(user.id, dayOfWeek, slots);
  }
}
