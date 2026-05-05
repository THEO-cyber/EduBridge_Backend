import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Logger, UseGuards } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';
import { ChatService } from './chat.service';
import { MessageType } from './dto/message-type.enum';

interface AuthenticatedSocket extends Socket {
  userId: string;
  user: any;
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private logger = new Logger('ChatGateway');
  private connectedUsers = new Map<string, Set<string>>(); // userId -> Set of socketIds
  private userRooms = new Map<string, Set<string>>(); // userId -> Set of roomIds

  constructor(
    private jwtService: JwtService,
    private chatService: ChatService,
  ) {}

  @OnEvent('chat.room.created')
  handleRoomCreatedEvent(payload: { userId: string; chatRoom: any }) {
    this.notifyRoomCreated(payload.userId, payload.chatRoom);
  }

  @OnEvent('chat.message.sent')
  handleMessageSentEvent(payload: { chatId: string; message: any }) {
    this.sendMessageToRoom(payload.chatId, payload.message);
  }

  async handleConnection(socket: Socket) {
    try {
      // Authenticate the socket connection
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn('Socket connection without token');
        socket.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify(token);
      const userId = payload.sub;

      // Store user info on socket
      (socket as AuthenticatedSocket).userId = userId;
      (socket as AuthenticatedSocket).user = payload;

      // Track connected users
      if (!this.connectedUsers.has(userId)) {
        this.connectedUsers.set(userId, new Set());
      }
      this.connectedUsers.get(userId)?.add(socket.id);

      // Join user-specific room
      socket.join(`user:${userId}`);

      this.logger.log(
        `User ${userId} connected to chat via socket ${socket.id}`,
      );

      // Send initial connection success
      socket.emit('connected', {
        message: 'Connected to chat',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Socket authentication failed:', error.message);
      socket.emit('auth_error', { message: 'Authentication failed' });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket) {
    const authSocket = socket as AuthenticatedSocket;
    if (authSocket.userId) {
      const userSockets = this.connectedUsers.get(authSocket.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          this.connectedUsers.delete(authSocket.userId);
          // Clean up user rooms tracking when fully disconnected
          this.userRooms.delete(authSocket.userId);
        }
      }
      this.logger.log(
        `User ${authSocket.userId} disconnected from chat socket ${socket.id}`,
      );
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('join_chat_room')
  async handleJoinRoom(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { roomId } = data;
    const userId = socket.userId;

    try {
      socket.join(`chat:${roomId}`);

      // Track user's rooms for cleanup
      if (!this.userRooms.has(userId)) {
        this.userRooms.set(userId, new Set());
      }
      this.userRooms.get(userId)?.add(roomId);

      socket.emit('room_joined', { roomId });

      // Notify others in the room that user is online
      socket.to(`chat:${roomId}`).emit('user_online', {
        userId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} joined chat room ${roomId}`);
    } catch (error) {
      socket.emit('room_error', {
        message: 'Failed to join room',
        roomId,
        error: error.message,
      });
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('leave_chat_room')
  async handleLeaveRoom(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { roomId } = data;
    const userId = socket.userId;

    socket.leave(`chat:${roomId}`);

    // Remove from user's rooms tracking
    const userRooms = this.userRooms.get(userId);
    if (userRooms) {
      userRooms.delete(roomId);
    }

    // Notify others in the room that user went offline
    socket.to(`chat:${roomId}`).emit('user_offline', {
      userId,
      timestamp: new Date().toISOString(),
    });

    socket.emit('room_left', { roomId });
    this.logger.log(`User ${userId} left chat room ${roomId}`);
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('send_message')
  async handleSendMessage(
    @MessageBody()
    data: {
      roomId: string;
      content: string;
      type?: MessageType;
      replyToId?: string;
    },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { roomId, content, type = MessageType.TEXT, replyToId } = data;
    const userId = socket.userId;

    try {
      const message = await this.chatService.sendMessage(roomId, userId, {
        content,
        type,
        replyToId,
      });

      // Message will be sent to room via ChatService -> sendMessageToRoom
      socket.emit('message_sent', { messageId: message.id });
    } catch (error) {
      socket.emit('message_error', {
        error: error.message,
        roomId,
      });
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing_start')
  async handleTypingStart(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { roomId } = data;
    const userId = socket.userId;

    socket.to(`chat:${roomId}`).emit('user_typing', {
      userId,
      roomId,
      isTyping: true,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('typing_stop')
  async handleTypingStop(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { roomId } = data;
    const userId = socket.userId;

    socket.to(`chat:${roomId}`).emit('user_typing', {
      userId,
      roomId,
      isTyping: false,
    });
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('mark_messages_read')
  async handleMarkMessagesRead(
    @MessageBody() data: { roomId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { roomId } = data;
    const userId = socket.userId;

    try {
      const result = await this.chatService.markMessagesAsRead(roomId, userId);
      socket.emit('messages_marked_read', {
        roomId,
        success: result.success,
      });

      // Notify others that user has read messages
      socket.to(`chat:${roomId}`).emit('messages_read_by_user', {
        userId,
        roomId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      socket.emit('mark_read_error', {
        error: error.message,
        roomId,
      });
    }
  }

  // Public methods for external services to send messages
  sendMessageToRoom(roomId: string, message: any) {
    this.server.to(`chat:${roomId}`).emit('new_message', {
      id: message.id,
      chatRoomId: message.chatRoomId,
      sender: message.sender,
      content: message.content,
      type: message.type,
      replyTo: message.replyTo,
      attachments: message.attachments,
      createdAt: message.createdAt,
      isDeleted: message.isDeleted,
    });

    this.logger.log(
      `Sent message to room ${roomId}: ${message.content.substring(0, 50)}...`,
    );
  }

  notifyRoomCreated(userId: string, chatRoom: any) {
    this.server.to(`user:${userId}`).emit('room_created', {
      id: chatRoom.id,
      name: chatRoom.name,
      type: chatRoom.type,
      participants: chatRoom.participants,
      createdBy: chatRoom.createdBy,
      createdAt: chatRoom.createdAt,
    });

    this.logger.log(`Notified user ${userId} about new room: ${chatRoom.name}`);
  }

  notifyParticipantJoined(roomId: string, participant: any) {
    this.server.to(`chat:${roomId}`).emit('participant_joined', {
      roomId,
      participant,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`User ${participant.userId} joined room ${roomId}`);
  }

  notifyParticipantLeft(roomId: string, userId: string) {
    this.server.to(`chat:${roomId}`).emit('participant_left', {
      roomId,
      userId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`User ${userId} left room ${roomId}`);
  }

  notifyMessageDeleted(roomId: string, messageId: string) {
    this.server.to(`chat:${roomId}`).emit('message_deleted', {
      roomId,
      messageId,
      timestamp: new Date().toISOString(),
    });

    this.logger.log(`Message ${messageId} deleted in room ${roomId}`);
  }

  // Utility methods
  isUserOnline(userId: string): boolean {
    return (
      this.connectedUsers.has(userId) &&
      (this.connectedUsers.get(userId)?.size || 0) > 0
    );
  }

  getOnlineUsersInRoom(roomId: string): string[] {
    const onlineUsers: string[] = [];
    for (const [userId, rooms] of this.userRooms.entries()) {
      if (rooms.has(roomId) && this.isUserOnline(userId)) {
        onlineUsers.push(userId);
      }
    }
    return onlineUsers;
  }

  getConnectedUserCount(): number {
    return this.connectedUsers.size;
  }
}
