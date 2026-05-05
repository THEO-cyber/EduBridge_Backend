import {
  Controller,
  Post,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { LiveSessionsService } from './live-sessions.service';
import { CreateSessionRequestDto } from './dto/session-request.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, User, SessionStatus } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';

class EndSessionDto {
  @IsOptional()
  @IsString()
  meetingNotes?: string;
}

@ApiTags('Live Sessions')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('live-sessions')
export class LiveSessionsController {
  constructor(private readonly liveSessionsService: LiveSessionsService) {}

  @UseGuards(RolesGuard)
  @Roles(Role.STUDENT)
  @Post('request')
  @ApiOperation({ summary: 'Request a live session (Student only)' })
  async createSessionRequest(
    @CurrentUser() user: User,
    @Body() createSessionRequestDto: CreateSessionRequestDto,
  ) {
    return this.liveSessionsService.createSessionRequest(
      user.id,
      createSessionRequestDto,
    );
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post('requests/:id/confirm')
  @ApiOperation({ summary: 'Confirm session request (Instructor only)' })
  async confirmSessionRequest(
    @Param('id') requestId: string,
    @CurrentUser() user: User,
  ) {
    return this.liveSessionsService.confirmSessionRequest(requestId, user.id);
  }

  @Post(':id/join')
  @ApiOperation({ summary: 'Join live session' })
  async joinSession(@Param('id') sessionId: string, @CurrentUser() user: User) {
    return this.liveSessionsService.joinSession(sessionId, user.id);
  }

  @Patch(':id/end')
  @ApiOperation({ summary: 'End live session' })
  async endSession(
    @Param('id') sessionId: string,
    @CurrentUser() user: User,
    @Body() endSessionDto: EndSessionDto,
  ) {
    return this.liveSessionsService.endSession(
      sessionId,
      user.id,
      endSessionDto.meetingNotes,
    );
  }

  @Get('my-sessions')
  @ApiOperation({ summary: 'Get user sessions' })
  @ApiQuery({ name: 'role', required: false, enum: ['instructor', 'student'] })
  async getUserSessions(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
    @Query('role') role?: 'instructor' | 'student',
  ) {
    return this.liveSessionsService.getUserSessions(
      user.id,
      paginationDto,
      role,
    );
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Get('requests')
  @ApiOperation({ summary: 'Get session requests (Instructor only)' })
  @ApiQuery({ name: 'status', required: false, enum: SessionStatus })
  async getSessionRequests(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
    @Query('status') status?: SessionStatus,
  ) {
    return this.liveSessionsService.getSessionRequests(
      user.id,
      paginationDto,
      status,
    );
  }
}
