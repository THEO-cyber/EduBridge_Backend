import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
// import { ChatGateway } from './chat.gateway';
import { PaginationDto } from '../../common/dto/pagination.dto';
// import { MessageType } from '../dto/message-type.enum'; // Temporarily removed

interface CreateChatRoomData {
  name: string;
  type: 'direct' | 'group' | 'course';
  participants: string[];
  relatedId?: string; // Course ID for course chats
  isPrivate?: boolean;
}

interface SendMessageData {
  content: string;
  type: string;
  replyToId?: string;
  attachments?: {
    fileName: string;
    fileUrl: string;
    fileSize: number;
    mimeType: string;
  }[];
}

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private eventEmitter: EventEmitter2,
  ) {}

  async createChatRoom(creatorId: string, data: CreateChatRoomData) {
    // Validate participants exist
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...data.participants, creatorId] } },
      select: { id: true },
    });

    if (users.length !== data.participants.length + 1) {
      throw new BadRequestException('One or more participants not found');
    }

    // Check for existing direct chat (disabled - requires type field in schema)
    /*
    if (data.type === 'direct' && data.participants.length === 1) {
      const existingChat = await this.prisma.chat.findFirst({
        where: {
          type: 'direct',
          participants: {
            every: {
              userId: { in: [creatorId, data.participants[0]] },
            },
          },
        },
        include: {
          participants: {
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                  avatar: true,
                },
              },
            },
          },
        },
      });

      if (existingChat) {
        return existingChat;
      }
    }
    */

    // Create chat room (simplified to use only available schema fields)
    const chatRoom = await this.prisma.chat.create({
      data: {
        name: data.name,
        // A room opened from the in-app "Support Chat" is tagged so admins can
        // find and answer it from the support inbox.
        ...((data.type as string) === 'support' || data.name === 'Support Chat'
          ? { type: 'support' }
          : {}),
        isGroupChat: data.participants?.length > 1 || false,
        participants: {
          create: [...data.participants, creatorId].map((userId) => ({
            userId,
            joinedAt: new Date(),
          })),
        },
      },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    });

    // Notify all participants about the new chat room
    for (const participant of chatRoom.participants) {
      this.eventEmitter.emit('chat.room.created', {
        userId: participant.userId,
        chatRoom,
      });
    }

    return chatRoom;
  }

  // Shared by the WS gateway (before allowing a socket to join a room) and any
  // REST path that needs to authorize access to a chat's contents.
  async isParticipant(chatId: string, userId: string): Promise<boolean> {
    const participant = await this.prisma.chatParticipant.findFirst({
      where: { chatId, userId },
      select: { id: true },
    });
    return !!participant;
  }

  async sendMessage(
    chatId: string,
    senderId: string,
    messageData: SendMessageData,
  ) {
    // Verify user is participant of the chat room
    const participant = await this.prisma.chatParticipant.findFirst({
      where: {
        chatId,
        userId: senderId,
      },
    });

    if (!participant) {
      throw new ForbiddenException(
        'Not authorized to send messages in this chat',
      );
    }

    // Create message
    const message = await this.prisma.chatMessage.create({
      data: {
        chatId,
        senderId,
        content: messageData.content,
        messageType: messageData.type || 'text',
        replyToId: messageData.replyToId,
        attachmentUrl: messageData.attachments?.[0]?.fileUrl, // Use single attachment URL for now
      },
      include: {
        sender: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        replyTo: {
          include: {
            sender: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
        // attachments: true, // Disabled
      },
    });

    // Update chat room's last message (we'll skip this since Chat model doesn't have these fields yet)
    // await this.prisma.chat.update({
    //   where: { id: chatId },
    //   data: {
    //     lastMessageAt: new Date(),
    //     lastMessageId: message.id,
    //   },
    // });

    // Send real-time message to all participants
    this.eventEmitter.emit('chat.message.sent', {
      chatId,
      message,
    });

    return message;
  }

  async getChatRooms(userId: string, paginationDto: PaginationDto) {
    const { page, limit, skip } = paginationDto;

    const [chatRooms, total] = await Promise.all([
      this.prisma.chat.findMany({
        where: {
          participants: {
            some: { userId },
          },
        },
        skip,
        take: limit,
        include: {
          participants: {
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                  avatar: true,
                },
              },
            },
          },
          // lastMessage: { // Disabled since Chat doesn't have lastMessage relation
          //   include: {
          //     sender: {
          //       select: {
          //   id: true,
          //   firstName: true,
          //   lastName: true,
          // },
          // },
          // },
          // },
          // _count: {
          //   select: {
          //     messages: true, // Just count all messages for now
          //   },
          // },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.chat.count({
        where: {
          participants: {
            some: { userId },
          },
        },
      }),
    ]);

    return {
      chatRooms: chatRooms.map((room) => ({
        ...room,
        messageCount: 0, // Simplified for now since _count not included
      })),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async getChatMessages(
    chatId: string,
    userId: string,
    paginationDto: PaginationDto,
  ) {
    // Verify user is participant
    const participant = await this.prisma.chatParticipant.findFirst({
      where: {
        chatId,
        userId,
      },
    });

    if (!participant) {
      throw new ForbiddenException('Not authorized to view this chat');
    }

    const { page, limit, skip } = paginationDto;

    const [messages, total] = await Promise.all([
      this.prisma.chatMessage.findMany({
        where: { chatId },
        skip,
        take: limit,
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
          replyTo: {
            include: {
              sender: {
                select: {
                  id: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
          // attachments: true, // Disabled since ChatMessage doesn't have attachments relation
          // readBy: { // Disabled since ChatMessage doesn't have readBy relation
          //   where: { userId },
          // },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.chatMessage.count({ where: { chatId } }),
    ]);

    return {
      messages: messages.reverse(),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async markMessagesAsRead(chatId: string, userId: string) {
    // Update the participant's lastReadAt timestamp
    const participant = await this.prisma.chatParticipant.findFirst({
      where: {
        chatId,
        userId,
      },
    });

    if (!participant) {
      throw new NotFoundException('User is not a participant in this chat');
    }

    await this.prisma.chatParticipant.update({
      where: { id: participant.id },
      data: { lastReadAt: new Date() },
    });

    return { success: true };
  }

  async addParticipant(chatId: string, userId: string, participantId: string) {
    // Verify user is participant and has permission (room creator or admin)
    const chatRoom = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: { where: { userId } },
      },
    });

    if (!chatRoom) {
      throw new NotFoundException('Chat room not found');
    }

    if (chatRoom.participants.length === 0) {
      throw new ForbiddenException('Not authorized to add participants');
    }

    // Skip type checking since Chat model doesn't have type field
    // if (chatRoom.type === 'direct') {
    //   throw new BadRequestException('Cannot add participants to direct chats');
    // }

    // Check if participant already exists
    const existingParticipant = await this.prisma.chatParticipant.findFirst({
      where: {
        chatId,
        userId: participantId,
      },
    });

    if (existingParticipant) {
      throw new BadRequestException('User is already a participant');
    }

    // Add participant
    const newParticipant = await this.prisma.chatParticipant.create({
      data: {
        chatId,
        userId: participantId,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    });

    // Notify room about new participant
    this.eventEmitter.emit('chat.participant.joined', {
      chatId,
      participant: newParticipant,
    });

    return newParticipant;
  }

  async removeParticipant(
    chatId: string,
    userId: string,
    participantId: string,
  ) {
    // Verify user is participant and has permission
    const chatRoom = await this.prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        participants: { where: { userId } },
      },
    });

    if (!chatRoom) {
      throw new NotFoundException('Chat room not found');
    }

    // Users can remove themselves (skip permission check since no createdById field)
    if (participantId !== userId) {
      throw new ForbiddenException('You can only remove yourself from chats');
    }

    // Remove participant
    await this.prisma.chatParticipant.deleteMany({
      where: {
        chatId,
        userId: participantId,
      },
    });

    // Notify room about participant leaving
    this.eventEmitter.emit('chat.participant.left', {
      chatId,
      participantId,
    });

    return { success: true };
  }

  async deleteMessage(messageId: string, userId: string) {
    const message = await this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.senderId !== userId) {
      throw new ForbiddenException('Not authorized to delete this message');
    }

    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: {
        content: '[Message deleted]',
        isEdited: true, // Use isEdited instead of isDeleted for now
      },
    });

    // Notify room about deleted message
    this.eventEmitter.emit('chat.message.deleted', {
      chatId: message.chatId,
      messageId,
    });

    return { success: true };
  }

  async getOrCreateCourseChat(courseId: string, requesterId: string) {
    const participantSelect = {
      include: {
        user: {
          select: { id: true, username: true, firstName: true, lastName: true, avatar: true },
        },
      },
    };

    // Return existing course chat if one already exists
    const existing = await this.prisma.chat.findFirst({
      where: { type: 'course', relatedId: courseId } as any,
      include: { participants: participantSelect },
    });

    if (existing) {
      // Ensure the requester is a participant (e.g. new enrollee)
      const isMember = existing.participants.some((p: any) => p.userId === requesterId);
      if (!isMember) {
        await this.prisma.chatParticipant.create({
          data: { chatId: existing.id, userId: requesterId },
        });
      }
      return existing;
    }

    // First time — create the room and seed it with instructor + all active enrollees
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: {
        enrollments: {
          where: { status: 'ACTIVE' },
          select: { userId: true },
        },
      },
    });

    if (!course) throw new NotFoundException('Course not found');

    const uniqueIds = [
      ...new Set([course.instructorId, ...course.enrollments.map((e) => e.userId)]),
    ];

    return this.prisma.chat.create({
      data: {
        name: `${course.title} Discussion`,
        type: 'course',
        relatedId: courseId,
        isGroupChat: true,
        participants: {
          create: uniqueIds.map((userId) => ({ userId })),
        },
      } as any,
      include: { participants: participantSelect },
    });
  }

  // ── Support inbox (admin) ────────────────────────────────────────────────

  private _isStaff(role?: string) {
    return role === 'ADMIN' || role === 'SUPER_ADMIN';
  }

  /** All support conversations, most-recently-active first. */
  async listSupportConversations() {
    const chats = await this.prisma.chat.findMany({
      where: { type: 'support' },
      include: {
        participants: {
          include: {
            user: {
              select: { id: true, firstName: true, lastName: true, email: true, avatar: true, role: true },
            },
          },
        },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: true } },
      },
    });

    const rows = chats.map((c: any) => {
      const requester =
        c.participants.find((p: any) => !this._isStaff(p.user.role))?.user ??
        c.participants[0]?.user ??
        null;
      const last = c.messages[0];
      return {
        id: c.id,
        user: requester
          ? {
              id: requester.id,
              name: `${requester.firstName ?? ''} ${requester.lastName ?? ''}`.trim(),
              email: requester.email,
              avatar: requester.avatar,
            }
          : null,
        lastMessage: last
          ? {
              content: last.content,
              createdAt: last.createdAt,
              fromUser: requester ? last.senderId === requester.id : true,
            }
          : null,
        messageCount: c._count.messages,
        lastActivityAt: last?.createdAt ?? c.updatedAt,
      };
    });

    rows.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    );
    return rows;
  }

  /** All messages in a support conversation (admin view — no participant check). */
  async getSupportMessages(roomId: string) {
    const chat = await this.prisma.chat.findFirst({ where: { id: roomId, type: 'support' } });
    if (!chat) throw new NotFoundException('Support conversation not found');

    const messages = await this.prisma.chatMessage.findMany({
      where: { chatId: roomId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { id: true, firstName: true, lastName: true, role: true } } },
    });

    return messages.map((m: any) => ({
      id: m.id,
      content: m.content,
      createdAt: m.createdAt,
      senderId: m.senderId,
      senderName: `${m.sender.firstName ?? ''} ${m.sender.lastName ?? ''}`.trim(),
      fromSupport: this._isStaff(m.sender.role),
    }));
  }

  /** Admin replies in a support conversation. */
  async adminReply(roomId: string, adminId: string, content: string) {
    const chat = await this.prisma.chat.findFirst({ where: { id: roomId, type: 'support' } });
    if (!chat) throw new NotFoundException('Support conversation not found');

    // Ensure the admin is a participant so gateway/notification hooks work.
    await this.prisma.chatParticipant.upsert({
      where: { chatId_userId: { chatId: roomId, userId: adminId } },
      create: { chatId: roomId, userId: adminId },
      update: {},
    });

    const message = await this.prisma.chatMessage.create({
      data: { chatId: roomId, senderId: adminId, content, messageType: 'text' },
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    await this.prisma.chat.update({ where: { id: roomId }, data: { updatedAt: new Date() } });

    this.eventEmitter.emit('chat.message.created', { chatId: roomId, message });

    return {
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      senderId: adminId,
      fromSupport: true,
    };
  }
}
