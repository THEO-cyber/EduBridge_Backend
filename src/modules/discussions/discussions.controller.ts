import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  DiscussionsService, CreateThreadDto, CreateReplyDto,
} from './discussions.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role, User } from '@prisma/client';

@ApiTags('Discussions')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('discussions')
export class DiscussionsController {
  constructor(private readonly discussionsService: DiscussionsService) {}

  @Post('threads')
  @ApiOperation({ summary: 'Start a discussion thread in a course' })
  createThread(@CurrentUser() user: User, @Body() dto: CreateThreadDto) {
    return this.discussionsService.createThread(user.id, dto);
  }

  @Get('threads/:courseId')
  @ApiOperation({ summary: 'List all discussion threads for a course' })
  getCourseThreads(
    @Param('courseId') courseId: string,
    @CurrentUser() user: User,
    @Query() pagination: PaginationDto,
  ) {
    return this.discussionsService.getCourseThreads(courseId, user.id, pagination);
  }

  @Get('thread/:id')
  @ApiOperation({ summary: 'Get a single discussion thread with all replies' })
  getThread(@Param('id') id: string, @CurrentUser() user: User) {
    return this.discussionsService.getThread(id, user.id);
  }

  @Post('thread/:id/reply')
  @ApiOperation({ summary: 'Reply to a discussion thread' })
  reply(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: CreateReplyDto,
  ) {
    return this.discussionsService.createReply(id, user.id, dto);
  }

  @Post('thread/:threadId/answer/:replyId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Mark a reply as the accepted answer (instructor only)' })
  markAnswer(
    @Param('threadId') threadId: string,
    @Param('replyId') replyId: string,
    @CurrentUser() user: User,
  ) {
    return this.discussionsService.markAnswered(threadId, replyId, user.id);
  }

  @Delete('post/:id')
  @ApiOperation({ summary: 'Delete a post (own posts or admin)' })
  deletePost(@Param('id') id: string, @CurrentUser() user: User) {
    return this.discussionsService.deletePost(id, user.id);
  }
}
