import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreateSessionRequestDto } from './dto/session-request.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { SessionStatus, Role } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class LiveSessionsService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async createSessionRequest(studentId: string, dto: CreateSessionRequestDto) {
    // Validate instructor exists and is available
    const instructor = await this.prisma.user.findUnique({
      where: { id: dto.instructorId, role: Role.INSTRUCTOR },
      include: {
        instructorProfile: true,
      },
    });

    if (!instructor || !instructor.instructorProfile) {
      throw new NotFoundException('Instructor not found');
    }

    if (!instructor.instructorProfile.isAvailableForSessions) {
      throw new BadRequestException('Instructor is not available for sessions');
    }

    // Calculate session cost
    const hourlyRate = instructor.instructorProfile.hourlyRate || 50;
    const totalAmount = Number(hourlyRate) * (dto.duration / 60);

    // Check for scheduling conflicts
    const preferredDate = new Date(dto.preferredDate);
    const endTime = new Date(preferredDate.getTime() + dto.duration * 60000);

    const conflictingSessions = await this.prisma.liveSession.findMany({
      where: {
        instructorId: dto.instructorId,
        status: { in: [SessionStatus.SCHEDULED, SessionStatus.IN_PROGRESS] },
        scheduledAt: {
          lte: endTime,
        },
        // Check if session ends after the requested start time
        AND: {
          scheduledAt: {
            gte: new Date(preferredDate.getTime() - 2 * 60 * 60 * 1000), // 2 hours buffer
          },
        },
      },
    });

    if (conflictingSessions.length > 0) {
      throw new BadRequestException(
        'Instructor has conflicting sessions at the requested time',
      );
    }

    // Create session request
    const sessionRequest = await this.prisma.sessionRequest.create({
      data: {
        studentId,
        instructorId: dto.instructorId,
        title: dto.title,
        description: dto.description,
        preferredDate,
        duration: dto.duration,
        hourlyRate,
        totalAmount,
        message: dto.message,
        status: SessionStatus.SCHEDULED,
      },
      include: {
        student: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            avatar: true,
          },
        },
      },
    });

    return sessionRequest;
  }

  async confirmSessionRequest(requestId: string, instructorId: string) {
    const sessionRequest = await this.prisma.sessionRequest.findUnique({
      where: { id: requestId },
      include: {
        student: true,
      },
    });

    if (!sessionRequest) {
      throw new NotFoundException('Session request not found');
    }

    if (sessionRequest.instructorId !== instructorId) {
      throw new ForbiddenException('Not authorized to confirm this session');
    }

    if (sessionRequest.status !== SessionStatus.SCHEDULED) {
      throw new BadRequestException('Session request cannot be confirmed');
    }

    // Create live session
    const liveSession = await this.prisma.liveSession.create({
      data: {
        sessionRequestId: requestId,
        instructorId,
        studentId: sessionRequest.studentId,
        title: sessionRequest.title,
        description: sessionRequest.description,
        scheduledAt: sessionRequest.preferredDate,
        duration: sessionRequest.duration,
        hourlyRate: sessionRequest.hourlyRate,
        totalAmount: sessionRequest.totalAmount,
        status: SessionStatus.SCHEDULED,
      },
      include: {
        instructor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            avatar: true,
          },
        },
        student: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            avatar: true,
          },
        },
      },
    });

    return liveSession;
  }

  async joinSession(sessionId: string, userId: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
      include: {
        instructor: true,
        student: true,
      },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    // Check if user is authorized to join
    if (session.instructorId !== userId && session.studentId !== userId) {
      throw new ForbiddenException('Not authorized to join this session');
    }

    // Check if session is scheduled for now or in the past
    const now = new Date();
    const sessionStart = new Date(session.scheduledAt);
    const joinWindow = 15 * 60 * 1000; // 15 minutes before session

    if (now < new Date(sessionStart.getTime() - joinWindow)) {
      throw new BadRequestException('Session has not started yet');
    }

    // Generate or get existing room ID
    let roomId = session.roomId;
    if (!roomId) {
      roomId = `session-${sessionId}-${Date.now()}`;
      await this.prisma.liveSession.update({
        where: { id: sessionId },
        data: { roomId },
      });
    }

    // Update session status if starting
    if (session.status === SessionStatus.SCHEDULED) {
      await this.prisma.liveSession.update({
        where: { id: sessionId },
        data: {
          status: SessionStatus.IN_PROGRESS,
          startedAt: now,
        },
      });
    }

    // Generate LiveKit access token (placeholder - implement with actual LiveKit SDK)
    const accessToken = this.generateLiveKitToken(roomId, userId, session);

    return {
      roomId,
      accessToken,
      session: {
        id: session.id,
        title: session.title,
        instructor: session.instructor,
        student: session.student,
        scheduledAt: session.scheduledAt,
        duration: session.duration,
      },
    };
  }

  async endSession(sessionId: string, userId: string, meetingNotes?: string) {
    const session = await this.prisma.liveSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (session.instructorId !== userId && session.studentId !== userId) {
      throw new ForbiddenException('Not authorized to end this session');
    }

    if (session.status !== SessionStatus.IN_PROGRESS) {
      throw new BadRequestException('Session is not in progress');
    }

    const updatedSession = await this.prisma.liveSession.update({
      where: { id: sessionId },
      data: {
        status: SessionStatus.COMPLETED,
        endedAt: new Date(),
        meetingNotes,
      },
    });

    return updatedSession;
  }

  async getUserSessions(
    userId: string,
    paginationDto: PaginationDto,
    role?: 'instructor' | 'student',
  ) {
    const { page, limit, skip } = paginationDto;

    let where: any;
    if (role === 'instructor') {
      where = { instructorId: userId };
    } else if (role === 'student') {
      where = { studentId: userId };
    } else {
      where = {
        OR: [{ instructorId: userId }, { studentId: userId }],
      };
    }

    const [sessions, total] = await Promise.all([
      this.prisma.liveSession.findMany({
        where,
        skip,
        take: limit,
        include: {
          instructor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
          student: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
        },
        orderBy: { scheduledAt: 'desc' },
      }),
      this.prisma.liveSession.count({ where }),
    ]);

    return {
      sessions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async getSessionRequests(
    instructorId: string,
    paginationDto: PaginationDto,
    status?: SessionStatus,
  ) {
    const { page, limit, skip } = paginationDto;

    const where: any = { instructorId };
    if (status) {
      where.status = status;
    }

    const [requests, total] = await Promise.all([
      this.prisma.sessionRequest.findMany({
        where,
        skip,
        take: limit,
        include: {
          student: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              avatar: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.sessionRequest.count({ where }),
    ]);

    return {
      requests,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  private generateLiveKitToken(
    roomId: string,
    userId: string,
    session: any,
  ): string {
    // This is a placeholder. In a real implementation, you would use the LiveKit SDK
    // to generate a proper access token with the configured API key and secret

    const payload = {
      roomId,
      userId,
      sessionId: session.id,
      role: session.instructorId === userId ? 'instructor' : 'student',
      exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60, // 2 hours
    };

    // Use LiveKit SDK to generate actual token:
    // import { AccessToken } from 'livekit-server-sdk';
    // const token = new AccessToken(apiKey, apiSecret, { identity: userId });
    // token.addGrant({ roomJoin: true, room: roomId });
    // return token.toJwt();

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }
}
