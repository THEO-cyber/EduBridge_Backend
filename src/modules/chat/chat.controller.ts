import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ChatService } from './chat.service';
import {
  CreateChatRoomDto,
  SendMessageDto,
  AddParticipantDto,
  RemoveParticipantDto,
} from './dto/chat.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

@ApiTags('Chat')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('rooms')
  @ApiOperation({ summary: 'Create a new chat room' })
  async createChatRoom(
    @CurrentUser() user: User,
    @Body() createChatRoomDto: CreateChatRoomDto,
  ) {
    return this.chatService.createChatRoom(user.id, {
      name: createChatRoomDto.name,
      type: createChatRoomDto.type,
      participants: createChatRoomDto.participants,
      relatedId: createChatRoomDto.relatedId,
      isPrivate: createChatRoomDto.isPrivate,
    });
  }

  @Get('rooms')
  @ApiOperation({ summary: 'Get user chat rooms' })
  async getChatRooms(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.chatService.getChatRooms(user.id, paginationDto);
  }

  @Get('rooms/:roomId/messages')
  @ApiOperation({ summary: 'Get chat messages' })
  async getChatMessages(
    @Param('roomId') roomId: string,
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.chatService.getChatMessages(roomId, user.id, paginationDto);
  }

  @Post('rooms/:roomId/messages')
  @ApiOperation({ summary: 'Send a message' })
  async sendMessage(
    @Param('roomId') roomId: string,
    @CurrentUser() user: User,
    @Body() sendMessageDto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(roomId, user.id, {
      content: sendMessageDto.content,
      type: sendMessageDto.type || 'text',
      replyToId: sendMessageDto.replyToId,
    });
  }

  @Post('rooms/:roomId/read')
  @ApiOperation({ summary: 'Mark messages as read' })
  async markMessagesAsRead(
    @Param('roomId') roomId: string,
    @CurrentUser() user: User,
  ) {
    return this.chatService.markMessagesAsRead(roomId, user.id);
  }

  @Post('rooms/:roomId/participants')
  @ApiOperation({ summary: 'Add participant to chat room' })
  async addParticipant(
    @Param('roomId') roomId: string,
    @CurrentUser() user: User,
    @Body() addParticipantDto: AddParticipantDto,
  ) {
    return this.chatService.addParticipant(
      roomId,
      user.id,
      addParticipantDto.participantId,
    );
  }

  @Delete('rooms/:roomId/participants/:participantId')
  @ApiOperation({ summary: 'Remove participant from chat room' })
  async removeParticipant(
    @Param('roomId') roomId: string,
    @Param('participantId') participantId: string,
    @CurrentUser() user: User,
  ) {
    return this.chatService.removeParticipant(roomId, user.id, participantId);
  }

  @Delete('messages/:messageId')
  @ApiOperation({ summary: 'Delete a message' })
  async deleteMessage(
    @Param('messageId') messageId: string,
    @CurrentUser() user: User,
  ) {
    return this.chatService.deleteMessage(messageId, user.id);
  }

  @Get('rooms/course/:courseId')
  @ApiOperation({ summary: 'Get or create course chat room' })
  async getCourseChat(
    @Param('courseId') courseId: string,
    @Query('courseName') courseName: string,
  ) {
    return this.chatService.getOrCreateCourseChat(
      courseId,
      courseName || 'Course Discussion',
    );
  }
}
