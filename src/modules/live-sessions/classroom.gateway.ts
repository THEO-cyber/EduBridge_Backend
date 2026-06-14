import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SessionStatus } from '@prisma/client';

interface AuthenticatedSocket extends Socket {
  userId: string;
  user: any;
}

interface ParticipantState {
  userId: string;
  name: string;
  initials: string;
  role: 'instructor' | 'student';
  videoEnabled: boolean;
  audioEnabled: boolean;
  handRaised: boolean;
  isScreenSharing: boolean;
}

interface DrawStroke {
  type: 'start' | 'move' | 'end' | 'clear' | 'text';
  x: number;
  y: number;
  color: string;
  lineWidth: number;
  tool: 'pen' | 'eraser' | 'text';
  text?: string;
}

interface StoredStroke extends DrawStroke {
  userId: string;
  timestamp: string;
}

interface WhiteboardState {
  active: boolean;
  strokes: StoredStroke[];
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  namespace: '/classroom',
})
export class ClassroomGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer() server: Server;
  private logger = new Logger('ClassroomGateway');

  // sessionId → (userId → ParticipantState)
  private sessionParticipants = new Map<string, Map<string, ParticipantState>>();
  // sessionId → WhiteboardState
  private sessionWhiteboards = new Map<string, WhiteboardState>();
  // sessionId → userId currently sharing screen (null = nobody)
  private sessionScreenShare = new Map<string, string | null>();
  // userId → Set of socketIds
  private connectedUsers = new Map<string, Set<string>>();

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(socket: Socket) {
    try {
      const token =
        socket.handshake.auth.token ||
        socket.handshake.headers.authorization?.replace('Bearer ', '');

      if (!token) {
        socket.disconnect(true);
        return;
      }

      const payload = this.jwtService.verify(token);
      const userId = payload.sub;

      (socket as AuthenticatedSocket).userId = userId;
      (socket as AuthenticatedSocket).user = payload;

      if (!this.connectedUsers.has(userId)) {
        this.connectedUsers.set(userId, new Set());
      }
      this.connectedUsers.get(userId)!.add(socket.id);

      socket.join(`user:${userId}`);

      socket.emit('connected', {
        message: 'Connected to classroom',
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} connected to classroom (socket ${socket.id})`);
    } catch {
      socket.emit('auth_error', { message: 'Authentication failed' });
      socket.disconnect(true);
    }
  }

  handleDisconnect(socket: Socket) {
    try {
      const s = socket as AuthenticatedSocket;
      if (!s.userId) return;

      const userSockets = this.connectedUsers.get(s.userId);
      if (userSockets) {
        userSockets.delete(socket.id);
        if (userSockets.size === 0) {
          this.connectedUsers.delete(s.userId);
        }
      }

      // Only clean up session presence if this was the user's last socket
      const remainingSockets = this.connectedUsers.get(s.userId);
      if (remainingSockets && remainingSockets.size > 0) return;

      for (const [sessionId, participants] of this.sessionParticipants.entries()) {
        if (!participants.has(s.userId)) continue;

        participants.delete(s.userId);
        this.server.to(`session:${sessionId}`).emit('participant_left', {
          userId: s.userId,
          timestamp: new Date().toISOString(),
        });

        if (this.sessionScreenShare.get(sessionId) === s.userId) {
          this.sessionScreenShare.set(sessionId, null);
          this.server.to(`session:${sessionId}`).emit('screen_share_stopped', {
            userId: s.userId,
            timestamp: new Date().toISOString(),
          });
        }
      }

      this.logger.log(`User ${s.userId} disconnected from classroom`);
    } catch (err) {
      this.logger.error(`Error in handleDisconnect: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('join_session')
  async handleJoinSession(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    const sessionId = data?.sessionId;
    const userId = socket.userId;

    if (!userId) {
      socket.emit('session_error', { message: 'Not authenticated' });
      return;
    }
    if (!sessionId) {
      socket.emit('session_error', { message: 'sessionId is required' });
      return;
    }

    try {
      const session = await (this.prisma as any).liveSession.findUnique({
        where: { id: sessionId },
        include: {
          instructor: {
            select: { id: true, firstName: true, lastName: true },
          },
          applications: {
            where: { studentId: userId, status: SessionStatus.IN_PROGRESS },
            select: { id: true },
          },
        },
      });

      if (!session) {
        socket.emit('session_error', { message: 'Session not found', sessionId });
        return;
      }

      const isInstructor = session.instructorId === userId;
      const isAcceptedStudent = (session.applications?.length ?? 0) > 0;

      if (!isInstructor && !isAcceptedStudent) {
        socket.emit('session_error', { message: 'Access denied to this session', sessionId });
        return;
      }

      const user = await (this.prisma as any).user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true },
      });

      const name = `${user.firstName} ${user.lastName}`;
      const initials = `${user.firstName[0]}${user.lastName[0]}`.toUpperCase();

      // Restore screen share state if this user was the sharer before reconnecting
      const wasSharing = this.sessionScreenShare.get(sessionId) === userId;

      const participant: ParticipantState = {
        userId,
        name,
        initials,
        role: isInstructor ? 'instructor' : 'student',
        videoEnabled: true,
        audioEnabled: true,
        handRaised: false,
        isScreenSharing: wasSharing,
      };

      if (!this.sessionParticipants.has(sessionId)) {
        this.sessionParticipants.set(sessionId, new Map());
      }
      this.sessionParticipants.get(sessionId)!.set(userId, participant);

      socket.join(`session:${sessionId}`);

      const participants = Array.from(
        this.sessionParticipants.get(sessionId)!.values(),
      );
      const whiteboard = this.sessionWhiteboards.get(sessionId) ?? {
        active: false,
        strokes: [],
      };
      const screenShareUserId = this.sessionScreenShare.get(sessionId) ?? null;

      socket.emit('session_joined', {
        sessionId,
        participants,
        whiteboard,
        screenShareUserId,
        timestamp: new Date().toISOString(),
      });

      // Notify everyone else that this participant joined/rejoined
      socket.to(`session:${sessionId}`).emit('participant_joined', {
        participant,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} joined classroom session ${sessionId}`);
    } catch (err) {
      this.logger.error(`join_session error for ${userId}: ${(err as Error).message}`);
      socket.emit('session_error', {
        message: 'Failed to join session',
        sessionId,
      });
    }
  }

  @SubscribeMessage('leave_session')
  handleLeaveSession(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      socket.leave(`session:${sessionId}`);

      const participants = this.sessionParticipants.get(sessionId);
      if (participants) participants.delete(userId);

      if (this.sessionScreenShare.get(sessionId) === userId) {
        this.sessionScreenShare.set(sessionId, null);
        this.server.to(`session:${sessionId}`).emit('screen_share_stopped', {
          userId,
          timestamp: new Date().toISOString(),
        });
      }

      socket.to(`session:${sessionId}`).emit('participant_left', {
        userId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} left classroom session ${sessionId}`);
    } catch (err) {
      this.logger.error(`leave_session error: ${(err as Error).message}`);
    }
  }

  // ── Get Session State (resync after reconnect) ──────────────────────────────

  @SubscribeMessage('get_session_state')
  handleGetSessionState(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participantsMap = this.sessionParticipants.get(sessionId);
      if (!participantsMap?.has(userId)) {
        socket.emit('session_error', {
          message: 'Not joined to this session. Call join_session first.',
          sessionId,
        });
        return;
      }

      socket.emit('session_state', {
        sessionId,
        participants: Array.from(participantsMap.values()),
        whiteboard: this.sessionWhiteboards.get(sessionId) ?? { active: false, strokes: [] },
        screenShareUserId: this.sessionScreenShare.get(sessionId) ?? null,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error(`get_session_state error: ${(err as Error).message}`);
    }
  }

  // ── Screen Sharing ──────────────────────────────────────────────────────────

  @SubscribeMessage('screen_share_start')
  handleScreenShareStart(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant || participant.role !== 'instructor') {
        socket.emit('session_error', { message: 'Only the instructor can share screen', sessionId });
        return;
      }

      const currentSharer = this.sessionScreenShare.get(sessionId);
      if (currentSharer && currentSharer !== userId) {
        socket.emit('session_error', { message: 'Another participant is already sharing', sessionId });
        return;
      }

      this.sessionScreenShare.set(sessionId, userId);
      participant.isScreenSharing = true;

      // Use socket.to() to exclude the sender — the instructor's frontend already
      // knows sharing started because they initiated it. Echoing it back can
      // cause the frontend to treat it as a remote share and break the UI.
      socket.to(`session:${sessionId}`).emit('screen_share_started', {
        userId,
        userName: participant.name,
        timestamp: new Date().toISOString(),
      });

      // Send a private ack to the instructor only
      socket.emit('screen_share_start_ack', {
        sessionId,
        success: true,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} started screen share in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`screen_share_start error: ${(err as Error).message}`);
      socket.emit('session_error', { message: 'Failed to start screen share' });
    }
  }

  @SubscribeMessage('screen_share_stop')
  handleScreenShareStop(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const currentSharer = this.sessionScreenShare.get(sessionId);

      // Allow stop if: this user is the current sharer, OR the map was already
      // cleared (can happen after a temporary disconnect) but this user is an
      // instructor in the session — they should still be able to clean up state.
      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      const isInstructor = participant?.role === 'instructor';

      if (currentSharer !== null && currentSharer !== userId) {
        // A different person is sharing — don't let this user stop them
        socket.emit('session_error', { message: 'You are not the current screen sharer', sessionId });
        return;
      }

      // Accept stop: either they were the sharer, or the map shows null (state
      // was cleared by a disconnect handler) and they're the instructor
      if (currentSharer === userId || (currentSharer === null && isInstructor)) {
        this.sessionScreenShare.set(sessionId, null);
        if (participant) participant.isScreenSharing = false;

        // Broadcast to the whole room (including sender) so everyone's UI updates
        this.server.to(`session:${sessionId}`).emit('screen_share_stopped', {
          userId,
          timestamp: new Date().toISOString(),
        });

        this.logger.log(`User ${userId} stopped screen share in session ${sessionId}`);
      }
    } catch (err) {
      this.logger.error(`screen_share_stop error: ${(err as Error).message}`);
      socket.emit('session_error', { message: 'Failed to stop screen share' });
    }
  }

  // ── Whiteboard ──────────────────────────────────────────────────────────────

  @SubscribeMessage('whiteboard_open')
  handleWhiteboardOpen(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant || participant.role !== 'instructor') {
        socket.emit('session_error', { message: 'Only the instructor can open the whiteboard', sessionId });
        return;
      }

      if (!this.sessionWhiteboards.has(sessionId)) {
        this.sessionWhiteboards.set(sessionId, { active: true, strokes: [] });
      } else {
        this.sessionWhiteboards.get(sessionId)!.active = true;
      }

      this.server.to(`session:${sessionId}`).emit('whiteboard_opened', {
        userId,
        strokes: this.sessionWhiteboards.get(sessionId)!.strokes,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Whiteboard opened in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`whiteboard_open error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('whiteboard_close')
  handleWhiteboardClose(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant || participant.role !== 'instructor') {
        socket.emit('session_error', { message: 'Only the instructor can close the whiteboard', sessionId });
        return;
      }

      const wb = this.sessionWhiteboards.get(sessionId);
      if (wb) wb.active = false;

      this.server.to(`session:${sessionId}`).emit('whiteboard_closed', {
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Whiteboard closed in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`whiteboard_close error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('whiteboard_draw')
  handleWhiteboardDraw(
    @MessageBody() data: { sessionId: string; stroke: DrawStroke },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const stroke = data?.stroke;
      const userId = socket.userId;
      if (!userId || !sessionId || !stroke) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant || participant.role !== 'instructor') {
        socket.emit('session_error', { message: 'Only the instructor can draw on the whiteboard', sessionId });
        return;
      }

      const wb = this.sessionWhiteboards.get(sessionId);
      if (!wb?.active) {
        socket.emit('session_error', { message: 'Whiteboard is not open', sessionId });
        return;
      }

      const storedStroke: StoredStroke = {
        ...stroke,
        userId,
        timestamp: new Date().toISOString(),
      };

      // Cap stored strokes at 2000 to prevent memory bloat; clients have the
      // full history in their own canvas so late-joiners use whiteboard_opened
      if (wb.strokes.length < 2000) {
        wb.strokes.push(storedStroke);
      }

      socket.to(`session:${sessionId}`).emit('whiteboard_drew', {
        userId,
        stroke: storedStroke,
      });
    } catch (err) {
      this.logger.error(`whiteboard_draw error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('whiteboard_clear')
  handleWhiteboardClear(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant || participant.role !== 'instructor') {
        socket.emit('session_error', { message: 'Only the instructor can clear the whiteboard', sessionId });
        return;
      }

      const wb = this.sessionWhiteboards.get(sessionId);
      if (wb) wb.strokes = [];

      this.server.to(`session:${sessionId}`).emit('whiteboard_cleared', {
        userId,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Whiteboard cleared in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`whiteboard_clear error: ${(err as Error).message}`);
    }
  }

  // ── Media State ─────────────────────────────────────────────────────────────

  @SubscribeMessage('media_state_change')
  handleMediaStateChange(
    @MessageBody()
    data: { sessionId: string; videoEnabled: boolean; audioEnabled: boolean },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant) return;

      participant.videoEnabled = data.videoEnabled;
      participant.audioEnabled = data.audioEnabled;

      // Broadcast to everyone including sender so their own participant tile updates
      this.server.to(`session:${sessionId}`).emit('participant_media_changed', {
        userId,
        name: participant.name,
        initials: participant.initials,
        videoEnabled: data.videoEnabled,
        audioEnabled: data.audioEnabled,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error(`media_state_change error: ${(err as Error).message}`);
    }
  }

  // ── Hand Raise ──────────────────────────────────────────────────────────────

  @SubscribeMessage('raise_hand')
  handleRaiseHand(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant) return;

      participant.handRaised = true;

      this.server.to(`session:${sessionId}`).emit('hand_raised', {
        userId,
        userName: participant.name,
        initials: participant.initials,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} raised hand in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`raise_hand error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('lower_hand')
  handleLowerHand(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant) return;

      participant.handRaised = false;

      this.server.to(`session:${sessionId}`).emit('hand_lowered', {
        userId,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      this.logger.error(`lower_hand error: ${(err as Error).message}`);
    }
  }

  @SubscribeMessage('call_on_student')
  handleCallOnStudent(
    @MessageBody() data: { sessionId: string; studentId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const studentId = data?.studentId;
      const userId = socket.userId;
      if (!userId || !sessionId || !studentId) return;

      const instructor = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!instructor || instructor.role !== 'instructor') {
        socket.emit('session_error', { message: 'Only the instructor can call on students', sessionId });
        return;
      }

      const student = this.sessionParticipants.get(sessionId)?.get(studentId);
      if (!student) {
        socket.emit('session_error', { message: 'Student not found in session', sessionId });
        return;
      }

      student.handRaised = false;

      this.server.to(`session:${sessionId}`).emit('called_on', {
        studentId,
        studentName: student.name,
        instructorId: userId,
        instructorName: instructor.name,
        timestamp: new Date().toISOString(),
      });

      // Direct alert to the student's personal room
      this.server.to(`user:${studentId}`).emit('you_were_called_on', {
        sessionId,
        instructorName: instructor.name,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`Instructor ${userId} called on student ${studentId} in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`call_on_student error: ${(err as Error).message}`);
    }
  }

  // ── Applause ────────────────────────────────────────────────────────────────

  @SubscribeMessage('applause')
  handleApplause(
    @MessageBody() data: { sessionId: string },
    @ConnectedSocket() socket: AuthenticatedSocket,
  ) {
    try {
      const sessionId = data?.sessionId;
      const userId = socket.userId;
      if (!userId || !sessionId) return;

      const participant = this.sessionParticipants.get(sessionId)?.get(userId);
      if (!participant) return;

      this.server.to(`session:${sessionId}`).emit('applause_reaction', {
        userId,
        userName: participant.name,
        timestamp: new Date().toISOString(),
      });

      this.logger.log(`User ${userId} triggered applause in session ${sessionId}`);
    } catch (err) {
      this.logger.error(`applause error: ${(err as Error).message}`);
    }
  }
}
