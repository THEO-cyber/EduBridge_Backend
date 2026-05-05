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
import { WsJwtGuard } from '../../common/guards/ws-jwt.guard';

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
  namespace: '/notifications',
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger = new Logger('NotificationsGateway');
  private connectedUsers = new Map<string, Set<string>>(); // userId -> Set of socketIds

  constructor(private jwtService: JwtService) {}

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

      this.logger.log(`User ${userId} connected via socket ${socket.id}`);

      // Send initial connection success
      socket.emit('connected', {
        message: 'Connected to notifications',
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
        }
      }
      this.logger.log(
        `User ${authSocket.userId} disconnected from socket ${socket.id}`,
      );
    }
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('mark_read')
  async handleMarkAsRead(
    @MessageBody() data: { notificationId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { notificationId } = data;
    const userId = socket.userId;

    // Emit acknowledgment back to the client
    socket.emit('notification_read', {
      notificationId,
      readAt: new Date().toISOString(),
    });

    this.logger.log(
      `User ${userId} marked notification ${notificationId} as read`,
    );
  }

  @UseGuards(WsJwtGuard)
  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @MessageBody() data: { room: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const { room } = data;
    const userId = socket.userId;

    // Validate room permissions (e.g., course rooms, chat rooms)
    if (await this.canJoinRoom(userId, room)) {
      socket.join(room);
      socket.emit('room_joined', { room });
      this.logger.log(`User ${userId} joined room ${room}`);
    } else {
      socket.emit('room_error', {
        message: 'Not authorized to join room',
        room,
      });
    }
  }

  // Public methods for sending notifications
  sendNotificationToUser(userId: string, notification: any) {
    this.server.to(`user:${userId}`).emit('notification', {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      data: notification.data,
      relatedId: notification.relatedId,
      createdAt: notification.createdAt,
      isRead: notification.isRead,
    });

    this.logger.log(
      `Sent notification to user ${userId}: ${notification.title}`,
    );
  }

  sendNotificationToRoom(room: string, notification: any) {
    this.server.to(room).emit('notification', notification);
    this.logger.log(`Sent notification to room ${room}: ${notification.title}`);
  }

  broadcastNotification(notification: any, excludeUser?: string) {
    const event = excludeUser
      ? this.server.except(`user:${excludeUser}`)
      : this.server;

    event.emit('broadcast_notification', notification);
    this.logger.log(`Broadcast notification: ${notification.title}`);
  }

  // Send live session updates
  sendSessionUpdate(sessionId: string, update: any) {
    this.server.to(`session:${sessionId}`).emit('session_update', update);
  }

  // Send real-time chat messages
  sendChatMessage(chatId: string, message: any) {
    this.server.to(`chat:${chatId}`).emit('chat_message', message);
  }

  // Utility methods
  isUserConnected(userId: string): boolean {
    return (
      this.connectedUsers.has(userId) &&
      (this.connectedUsers.get(userId)?.size || 0) > 0
    );
  }

  getConnectedUserCount(): number {
    return this.connectedUsers.size;
  }

  getUserSocketIds(userId: string): string[] {
    const sockets = this.connectedUsers.get(userId);
    return sockets ? Array.from(sockets) : [];
  }

  private async canJoinRoom(userId: string, room: string): Promise<boolean> {
    // Implement room permission logic based on your business rules
    // For example:
    // - course:courseId -> check if user is enrolled or instructor
    // - chat:chatId -> check if user is participant
    // - session:sessionId -> check if user is participant

    if (room.startsWith('user:')) {
      return room === `user:${userId}`;
    }

    if (room.startsWith('course:')) {
      // Check course enrollment/instruction
      return true; // Placeholder - implement actual logic
    }

    if (room.startsWith('chat:')) {
      // Check chat participation
      return true; // Placeholder - implement actual logic
    }

    if (room.startsWith('session:')) {
      // Check session participation
      return true; // Placeholder - implement actual logic
    }

    return false;
  }
}
