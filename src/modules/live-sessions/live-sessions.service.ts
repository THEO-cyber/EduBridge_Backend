import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../../common/email/email.service';
import { CreateSessionRequestDto } from './dto/session-request.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { SessionStatus, Role, NotificationType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { CreateLiveSessionDto, UpdateLiveSessionDto, NotifySessionDto } from './dto/live-session.dto';

export { CreateLiveSessionDto, UpdateLiveSessionDto, NotifySessionDto };

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class LiveSessionsService {
  private readonly logger = new Logger(LiveSessionsService.name);
  private roomService?: RoomServiceClient;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {
    const wsUrl     = this.configService.get<string>('livekit.wsUrl');
    const apiKey    = this.configService.get<string>('livekit.apiKey');
    const apiSecret = this.configService.get<string>('livekit.apiSecret');

    if (wsUrl && apiKey && apiSecret) {
      this.roomService = new RoomServiceClient(wsUrl, apiKey, apiSecret);
    } else {
      this.logger.warn('LiveKit credentials not configured — live sessions will not work');
    }
  }

  // ── Instructor: create a live session ──────────────────────────────────────

  async createLiveSession(instructorId: string, dto: CreateLiveSessionDto) {
    const instructor = await this.prisma.user.findUnique({
      where: { id: instructorId, role: Role.INSTRUCTOR },
      include: { instructorProfile: true },
    });
    if (!instructor?.instructorProfile) throw new NotFoundException('Instructor profile not found');

    const scheduledAt = new Date(dto.scheduledAt);
    if (scheduledAt <= new Date()) {
      throw new BadRequestException('Scheduled time must be in the future');
    }

    // Conflict detection — no two sessions by same instructor can overlap
    await this.checkConflict(instructorId, scheduledAt, dto.duration);

    if (dto.courseId) {
      const course = await this.prisma.course.findUnique({ where: { id: dto.courseId } });
      if (!course) throw new NotFoundException('Course not found');
    }

    const session = await (this.prisma as any).liveSession.create({
      data: {
        instructorId,
        title:       dto.title,
        description: dto.description,
        scheduledAt,
        duration:    dto.duration,
        maxStudents: dto.maxStudents ?? 30,
        isPublic:    dto.isPublic   ?? true,
        courseId:    dto.courseId   ?? null,
        status:      SessionStatus.SCHEDULED,
      },
      include: {
        instructor: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        course:     { select: { id: true, title: true, slug: true } },
      },
    });

    this.logger.log(`Live session created: "${session.title}" by instructor ${instructorId}`);
    return session;
  }

  // ── Instructor: update a live session ─────────────────────────────────────

  async updateLiveSession(sessionId: string, instructorId: string, dto: UpdateLiveSessionDto) {
    const session = await (this.prisma as any).liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.instructorId !== instructorId) throw new ForbiddenException('Not your session');
    if (session.status === SessionStatus.COMPLETED || session.status === SessionStatus.CANCELLED) {
      throw new BadRequestException('Cannot edit a completed or cancelled session');
    }

    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;
    if (scheduledAt) {
      if (scheduledAt <= new Date()) throw new BadRequestException('Scheduled time must be in the future');
      // Re-run conflict detection, excluding this session from the check
      const duration = dto.duration ?? session.duration;
      const end = new Date(scheduledAt.getTime() + duration * 60_000);

      const candidates = await (this.prisma as any).liveSession.findMany({
        where: {
          instructorId,
          id:     { not: sessionId },
          status: { in: [SessionStatus.SCHEDULED, SessionStatus.IN_PROGRESS] },
          scheduledAt: {
            gte: new Date(scheduledAt.getTime() - 24 * 60 * 60_000),
            lt:  new Date(end.getTime()          + 24 * 60 * 60_000),
          },
        },
        select: { id: true, title: true, scheduledAt: true, duration: true },
      });

      for (const s of candidates) {
        const sEnd = new Date(s.scheduledAt.getTime() + s.duration * 60_000);
        if (s.scheduledAt < end && sEnd > scheduledAt) {
          throw new ConflictException(
            `Conflicts with "${s.title}" at ${new Date(s.scheduledAt).toISOString()}`,
          );
        }
      }
    }

    return (this.prisma as any).liveSession.update({
      where: { id: sessionId },
      data: {
        ...(dto.title       !== undefined && { title:       dto.title }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(scheduledAt                   && { scheduledAt }),
        ...(dto.duration    !== undefined && { duration:    dto.duration }),
        ...(dto.maxStudents !== undefined && { maxStudents: dto.maxStudents }),
        ...(dto.isPublic    !== undefined && { isPublic:    dto.isPublic }),
      },
      include: {
        instructor: { select: { id: true, firstName: true, lastName: true } },
        course:     { select: { id: true, title: true } },
      },
    });
  }

  async deleteLiveSession(sessionId: string, instructorId: string) {
    const session = await (this.prisma as any).liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.instructorId !== instructorId) throw new ForbiddenException('Not your session');
    if (session.status === SessionStatus.COMPLETED) {
      throw new BadRequestException('Cannot delete a completed session');
    }

    await (this.prisma as any).liveSession.delete({ where: { id: sessionId } });
    return { success: true, message: 'Session deleted' };
  }

  // ── Students: browse upcoming public sessions ───────────────────────────────

  async browseUpcomingSessions(
    pagination: PaginationDto,
    filters: { instructorId?: string; courseId?: string; status?: SessionStatus },
  ) {
    const { page = 1, limit = 20, skip = 0 } = pagination;

    // Show: scheduled (future), currently in-progress, or scheduled that just started
    // (within the last 4 hours so students can still join an in-progress class)
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60_000);
    const baseWhere: any = {
      isPublic: true,
      ...(filters.instructorId && { instructorId: filters.instructorId }),
      ...(filters.courseId     && { courseId:     filters.courseId }),
    };
    const where: any = filters.status
      ? { ...baseWhere, status: filters.status }
      : {
          ...baseWhere,
          OR: [
            { status: SessionStatus.SCHEDULED,  scheduledAt: { gte: new Date() } },
            { status: SessionStatus.IN_PROGRESS, scheduledAt: { gte: fourHoursAgo } },
          ],
        };

    const [sessions, total] = await Promise.all([
      (this.prisma as any).liveSession.findMany({
        where,
        skip,
        take: limit,
        orderBy: { scheduledAt: 'asc' },
        include: {
          instructor:    { select: { id: true, firstName: true, lastName: true, avatar: true } },
          course:        { select: { id: true, title: true, slug: true } },
          _count:        { select: { applications: true } },
        },
      }),
      (this.prisma as any).liveSession.count({ where }),
    ]);

    return {
      sessions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ── Student: apply to a session ────────────────────────────────────────────

  async applyToSession(sessionId: string, studentId: string, message?: string) {
    const session = await (this.prisma as any).liveSession.findUnique({
      where: { id: sessionId },
      include: { _count: { select: { applications: true } } },
    });

    if (!session)                                    throw new NotFoundException('Session not found');
    if (!session.isPublic)                           throw new ForbiddenException('This session is not open for applications');
    if (session.status !== SessionStatus.SCHEDULED)  throw new BadRequestException('This session is no longer accepting applications');
    if (new Date(session.scheduledAt) <= new Date()) throw new BadRequestException('Cannot apply to a session that has already started');

    // Check accepted count against maxStudents
    const acceptedCount = await this.prisma.sessionRequest.count({
      where: { liveSessionId: sessionId, status: SessionStatus.SCHEDULED } as any,
    });
    if (acceptedCount >= session.maxStudents) {
      throw new BadRequestException(`This session is full (${session.maxStudents} students max)`);
    }

    // No duplicate applications
    const existing = await this.prisma.sessionRequest.findFirst({
      where: { liveSessionId: sessionId, studentId } as any,
    });
    if (existing) throw new ConflictException('You have already applied to this session');

    const application = await this.prisma.sessionRequest.create({
      data: {
        studentId,
        instructorId:  session.instructorId,
        liveSessionId: sessionId,
        title:         session.title,
        description:   session.description,
        preferredDate: session.scheduledAt,
        duration:      session.duration,
        message,
        status:        SessionStatus.SCHEDULED,  // SCHEDULED = pending review
      } as any,
      include: {
        student: { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    // Notify instructor
    this.notificationsService.createNotification({
      userId:    session.instructorId,
      type:      NotificationType.NEW_ENROLLMENT,
      title:     'New session application',
      message:   `A student applied to "${session.title}"`,
      actionUrl: `/live-sessions/${sessionId}/applications`,
    }).catch(() => {});

    return { application, message: 'Application submitted — waiting for instructor approval' };
  }

  // ── Instructor: view applications for a session ────────────────────────────

  async getSessionApplications(sessionId: string, instructorId: string, pagination: PaginationDto) {
    const session = await (this.prisma as any).liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.instructorId !== instructorId) throw new ForbiddenException('Not your session');

    const { page = 1, limit = 50, skip = 0 } = pagination;
    const where: any = { liveSessionId: sessionId };

    const [applications, total] = await Promise.all([
      this.prisma.sessionRequest.findMany({
        where,
        skip,
        take: limit,
        include: { student: { select: { id: true, firstName: true, lastName: true, avatar: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.sessionRequest.count({ where }),
    ]);

    return {
      applications,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }

  // ── Instructor: accept an application ─────────────────────────────────────

  async acceptApplication(applicationId: string, instructorId: string) {
    const app = await this.prisma.sessionRequest.findUnique({
      where: { id: applicationId },
      include: { student: true },
    });

    if (!app)                                   throw new NotFoundException('Application not found');
    if ((app as any).instructorId !== instructorId) throw new ForbiddenException('Not your session');
    if (app.status !== SessionStatus.SCHEDULED) throw new BadRequestException('Application already processed');

    const liveSessionId = (app as any).liveSessionId;
    if (!liveSessionId) throw new BadRequestException('This application is not linked to a group session');

    const session = await (this.prisma as any).liveSession.findUnique({ where: { id: liveSessionId } });
    if (!session) throw new NotFoundException('Session not found');

    // Check capacity
    const acceptedCount = await this.prisma.sessionRequest.count({
      where: { liveSessionId: session.id, status: SessionStatus.IN_PROGRESS } as any,
    });
    if (acceptedCount >= session.maxStudents) {
      throw new BadRequestException(`Session is full (${session.maxStudents} max)`);
    }

    // IN_PROGRESS on SessionRequest = "accepted/confirmed"
    const updated = await this.prisma.sessionRequest.update({
      where: { id: applicationId },
      data:  { status: SessionStatus.IN_PROGRESS } as any,
      include: { student: true },
    });

    const student = updated.student as any;

    // Notify student
    this.notificationsService.createNotification({
      userId:    (app as any).studentId,
      type:      NotificationType.SYSTEM_ALERT,
      title:     'Application accepted!',
      message:   `You have been accepted for "${session.title}" on ${new Date(session.scheduledAt).toDateString()}`,
      actionUrl: `/live-sessions/${session.id}`,
    }).catch(() => {});

    const frontendUrl = this.configService.get<string>('frontendUrl') || '';
    if (student?.email) {
      this.emailService.sendSessionConfirmedToStudent(
        student.email,
        `${student.firstName} ${student.lastName}`,
        session.title,
        'your instructor',
        new Date(session.scheduledAt),
        frontendUrl,
      ).catch(() => {});
    }

    return { application: updated, message: 'Student accepted' };
  }

  // ── Instructor: reject an application ─────────────────────────────────────

  async rejectApplication(applicationId: string, instructorId: string) {
    const app = await this.prisma.sessionRequest.findUnique({ where: { id: applicationId } });
    if (!app) throw new NotFoundException('Application not found');
    if ((app as any).instructorId !== instructorId) throw new ForbiddenException('Not your session');
    if (app.status !== SessionStatus.SCHEDULED) throw new BadRequestException('Application already processed');

    const updated = await this.prisma.sessionRequest.update({
      where: { id: applicationId },
      data:  { status: SessionStatus.CANCELLED } as any,
    });

    this.notificationsService.createNotification({
      userId:    (app as any).studentId,
      type:      NotificationType.SYSTEM_ALERT,
      title:     'Application not accepted',
      message:   `Your application for "${app.title}" was not accepted this time`,
    }).catch(() => {});

    return { application: updated, message: 'Application rejected' };
  }

  // ── Instructor: notify all accepted students ───────────────────────────────

  async notifyAcceptedStudents(sessionId: string, instructorId: string, dto: NotifySessionDto) {
    const session = await (this.prisma as any).liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');
    if (session.instructorId !== instructorId) throw new ForbiddenException('Not your session');

    const accepted = await this.prisma.sessionRequest.findMany({
      where: { liveSessionId: sessionId, status: SessionStatus.IN_PROGRESS } as any,
      select: { studentId: true },
    });

    if (accepted.length === 0) throw new BadRequestException('No accepted students to notify');

    const title   = dto.title   ?? `Update: ${session.title}`;
    const message = dto.message;

    await Promise.all(
      accepted.map((a: any) =>
        this.notificationsService.createNotification({
          userId:    a.studentId,
          type:      NotificationType.SYSTEM_ALERT,
          title,
          message,
          actionUrl: `/live-sessions/${sessionId}`,
        }).catch(() => {}),
      ),
    );

    this.logger.log(`Notified ${accepted.length} accepted students for session ${sessionId}`);
    return { notified: accepted.length, message: 'Notifications sent' };
  }

  // ── Join session ───────────────────────────────────────────────────────────

  async joinSession(sessionId: string, userId: string) {
    const session = await (this.prisma as any).liveSession.findUnique({
      where:   { id: sessionId },
      include: { instructor: true, student: true },
    });

    if (!session) throw new NotFoundException('Session not found');

    const isInstructor = session.instructorId === userId;

    if (!isInstructor) {
      // For 1-on-1 sessions (old flow): check studentId
      // For group sessions: check accepted application
      const isDirectStudent = session.studentId === userId;
      const hasAcceptedApp  = await this.prisma.sessionRequest.findFirst({
        where: { liveSessionId: sessionId, studentId: userId, status: SessionStatus.IN_PROGRESS } as any,
      });

      if (!isDirectStudent && !hasAcceptedApp) {
        throw new ForbiddenException('You are not accepted for this session');
      }
    }

    const now = new Date();
    // Block joining only when too early; always allow if already IN_PROGRESS
    if (session.status !== SessionStatus.IN_PROGRESS) {
      const joinWindowMs = 15 * 60 * 1000;
      if (now < new Date(session.scheduledAt.getTime() - joinWindowMs)) {
        throw new BadRequestException('Session has not started yet — join up to 15 minutes before scheduled time');
      }
    }
    if (session.status === SessionStatus.COMPLETED) {
      throw new BadRequestException('This session has already ended');
    }
    if (session.status === SessionStatus.CANCELLED) {
      throw new BadRequestException('This session was cancelled');
    }

    let roomId = session.roomId;
    if (!roomId) {
      roomId = `edubridge-${sessionId}`;
      await (this.prisma as any).liveSession.update({ where: { id: sessionId }, data: { roomId } });
    }

    if (this.roomService) {
      try {
        await this.roomService.createRoom({ name: roomId, emptyTimeout: 600, maxParticipants: session.maxStudents + 1 });
      } catch (err: any) {
        this.logger.debug(`Room create: ${err.message}`);
      }
    }

    if (session.status === SessionStatus.SCHEDULED) {
      await (this.prisma as any).liveSession.update({
        where: { id: sessionId },
        data:  { status: SessionStatus.IN_PROGRESS, startedAt: now },
      });
    }

    const accessToken = await this.generateAccessToken(roomId, userId, isInstructor, session);

    return {
      roomId,
      accessToken,
      livekitUrl: this.configService.get<string>('livekit.wsUrl'),
      session: {
        id:          session.id,
        title:       session.title,
        instructor:  session.instructor,
        scheduledAt: session.scheduledAt,
        duration:    session.duration,
      },
    };
  }

  // ── End session ─────────────────────────────────────────────────────────────

  async endSession(sessionId: string, userId: string, meetingNotes?: string) {
    const session = await (this.prisma as any).liveSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    const isInstructor    = session.instructorId === userId;
    const isDirectStudent = session.studentId     === userId;
    const hasAcceptedApp  = !isInstructor && !isDirectStudent
      ? await this.prisma.sessionRequest.findFirst({
          where: { liveSessionId: sessionId, studentId: userId, status: SessionStatus.IN_PROGRESS } as any,
        })
      : null;

    if (!isInstructor && !isDirectStudent && !hasAcceptedApp) {
      throw new ForbiddenException('Not authorized to end this session');
    }
    if (session.status !== SessionStatus.IN_PROGRESS) {
      throw new BadRequestException('Session is not in progress');
    }

    if (this.roomService && session.roomId) {
      try { await this.roomService.deleteRoom(session.roomId); } catch (e: any) {
        this.logger.warn(`Could not delete LiveKit room: ${e.message}`);
      }
    }

    const completed = await (this.prisma as any).liveSession.update({
      where: { id: sessionId },
      data:  { status: SessionStatus.COMPLETED, endedAt: new Date(), meetingNotes },
    });

    // Notify accepted students to leave a review for the linked course
    if (session.courseId) {
      this.notifyStudentsToReview(sessionId, session).catch(() => {});
    }

    return completed;
  }

  private async notifyStudentsToReview(sessionId: string, session: any) {
    const applications = await this.prisma.sessionRequest.findMany({
      where: { liveSessionId: sessionId, status: SessionStatus.IN_PROGRESS } as any,
      include: {
        student: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const frontendUrl = this.configService.get<string>('frontendUrl') || '';

    for (const app of applications) {
      const student = app.student as any;
      if (!student) continue;

      // Check they haven't already reviewed this course
      const existing = await this.prisma.review.findUnique({
        where: { userId_courseId: { userId: student.id, courseId: session.courseId } },
      });
      if (existing) continue;

      this.notificationsService.createNotification({
        userId:    student.id,
        type:      NotificationType.LIVE_SESSION,
        title:     'How was the session?',
        message:   `You attended "${session.title}" — share your experience and leave a review!`,
        actionUrl: `/courses/${session.courseId}#reviews`,
      }).catch(() => {});

      if (student.email) {
        this.emailService.sendSessionReviewPrompt(
          student.email,
          `${student.firstName} ${student.lastName}`,
          session.title,
          session.courseId,
          frontendUrl,
        ).catch(() => {});
      }
    }
  }

  async getSessionReviews(sessionId: string, requesterId: string) {
    const session = await (this.prisma as any).liveSession.findUnique({
      where: { id: sessionId },
    });
    if (!session) throw new NotFoundException('Session not found');

    const isInstructor = session.instructorId === requesterId;
    // Superadmin/admin check happens at controller level via RolesGuard

    if (!isInstructor) {
      const isAdmin = await this.prisma.user.findUnique({
        where: { id: requesterId },
        select: { role: true },
      });
      if (!isAdmin || !['ADMIN', 'SUPER_ADMIN'].includes(isAdmin.role)) {
        throw new ForbiddenException('Only the instructor or an admin can view session reviews');
      }
    }

    if (!session.courseId) {
      return { reviews: [], total: 0, message: 'This session is not linked to a course' };
    }

    // Find all student IDs who attended this session
    const applications = await this.prisma.sessionRequest.findMany({
      where: { liveSessionId: sessionId, status: SessionStatus.IN_PROGRESS } as any,
      select: { studentId: true },
    });
    const attendeeIds = applications.map((a: any) => a.studentId);

    if (attendeeIds.length === 0) {
      return { reviews: [], total: 0 };
    }

    const reviews = await this.prisma.review.findMany({
      where: {
        courseId: session.courseId,
        userId: { in: attendeeIds },
      },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, avatar: true, username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      sessionId,
      courseId:   session.courseId,
      reviews,
      total:      reviews.length,
      attendees:  attendeeIds.length,
    };
  }

  // ── Get user's sessions ────────────────────────────────────────────────────

  async getUserSessions(userId: string, pagination: PaginationDto, role?: 'instructor' | 'student') {
    const { page = 1, limit = 20, skip = 0 } = pagination;

    // For students: only show sessions they were ACCEPTED into (application status = IN_PROGRESS)
    // so they can always find + join their upcoming/current classes
    const acceptedApp = { applications: { some: { studentId: userId, status: SessionStatus.IN_PROGRESS } } };
    const where: any = role === 'instructor'
      ? { instructorId: userId }
      : role === 'student'
        ? { OR: [{ studentId: userId }, acceptedApp] }
        : { OR: [{ instructorId: userId }, { studentId: userId }, acceptedApp] };

    const [sessions, total] = await Promise.all([
      (this.prisma as any).liveSession.findMany({
        where,
        skip,
        take: limit,
        include: {
          instructor: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          course:     { select: { id: true, title: true } },
          _count:     { select: { applications: true } },
        },
        orderBy: { scheduledAt: 'desc' },
      }),
      (this.prisma as any).liveSession.count({ where }),
    ]);

    return { sessions, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  // ── Legacy: student-initiated request (1-on-1) ─────────────────────────────

  async createSessionRequest(studentId: string, dto: CreateSessionRequestDto) {
    const instructor = await this.prisma.user.findUnique({
      where: { id: dto.instructorId, role: Role.INSTRUCTOR },
      include: { instructorProfile: true },
    });
    if (!instructor?.instructorProfile) throw new NotFoundException('Instructor not found');
    if (!instructor.instructorProfile.isAvailableForSessions) {
      throw new BadRequestException('Instructor is not accepting sessions');
    }

    const hourlyRate  = Number(instructor.instructorProfile.hourlyRate ?? 50);
    const totalAmount = hourlyRate * (dto.duration / 60);
    const preferredDate = new Date(dto.preferredDate);
    const endTime       = new Date(preferredDate.getTime() + dto.duration * 60_000);

    await this.checkConflict(dto.instructorId, preferredDate, dto.duration);

    return this.prisma.sessionRequest.create({
      data: {
        studentId,
        instructorId:  dto.instructorId,
        title:         dto.title,
        description:   dto.description,
        preferredDate,
        duration:      dto.duration,
        hourlyRate,
        totalAmount,
        message:       dto.message,
        status:        SessionStatus.SCHEDULED,
      } as any,
      include: {
        student: { select: { id: true, username: true, firstName: true, lastName: true, avatar: true } },
      },
    });
  }

  async confirmSessionRequest(requestId: string, instructorId: string) {
    const request = await this.prisma.sessionRequest.findUnique({
      where: { id: requestId },
      include: { student: true },
    });
    if (!request) throw new NotFoundException('Session request not found');
    if ((request as any).instructorId !== instructorId) throw new ForbiddenException('Not authorized');
    if (request.status !== SessionStatus.SCHEDULED) throw new BadRequestException('Not confirmable');

    await this.checkConflict(instructorId, (request as any).preferredDate, request.duration);

    const liveSession = await (this.prisma as any).liveSession.create({
      data: {
        sessionRequestId: requestId,
        instructorId,
        studentId:        (request as any).studentId,
        title:            request.title,
        description:      request.description,
        scheduledAt:      (request as any).preferredDate,
        duration:         request.duration,
        hourlyRate:       (request as any).hourlyRate,
        totalAmount:      (request as any).totalAmount,
        status:           SessionStatus.SCHEDULED,
      },
      include: {
        instructor: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        student:    { select: { id: true, firstName: true, lastName: true, avatar: true } },
      },
    });

    const frontendUrl    = this.configService.get<string>('frontendUrl') || '';
    const instructorName = `${(liveSession.instructor as any).firstName} ${(liveSession.instructor as any).lastName}`;
    const student        = request.student as any;

    this.notificationsService.notifyLiveSessionScheduled(
      (liveSession as any).studentId, liveSession.title, instructorName, liveSession.scheduledAt, liveSession.id,
    ).catch(() => {});

    if (student?.email) {
      this.emailService.sendSessionConfirmedToStudent(
        student.email, `${student.firstName} ${student.lastName}`,
        liveSession.title, instructorName, liveSession.scheduledAt, frontendUrl,
      ).catch(() => {});
    }

    return liveSession;
  }

  async getSessionRequests(instructorId: string, pagination: PaginationDto, status?: SessionStatus) {
    const { page = 1, limit = 20, skip = 0 } = pagination;
    const where: any = { instructorId, liveSessionId: null };
    if (status) where.status = status;

    const [requests, total] = await Promise.all([
      this.prisma.sessionRequest.findMany({
        where, skip, take: limit,
        include: { student: { select: { id: true, firstName: true, lastName: true, avatar: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.sessionRequest.count({ where }),
    ]);

    return { requests, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async cancelSessionRequest(requestId: string, userId: string) {
    const request = await this.prisma.sessionRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new NotFoundException('Not found');
    if ((request as any).studentId !== userId && (request as any).instructorId !== userId) {
      throw new ForbiddenException('Not authorized');
    }
    if (request.status === SessionStatus.COMPLETED || request.status === SessionStatus.CANCELLED) {
      throw new BadRequestException('Cannot cancel in current state');
    }
    return this.prisma.sessionRequest.update({ where: { id: requestId }, data: { status: SessionStatus.CANCELLED } as any });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async checkConflict(instructorId: string, start: Date, durationMinutes: number) {
    const end = new Date(start.getTime() + durationMinutes * 60_000);

    // Fetch all sessions that could potentially overlap (those starting within a 24-hour
    // window), then compute the exact overlap in memory to avoid raw SQL portability issues.
    const candidates = await (this.prisma as any).liveSession.findMany({
      where: {
        instructorId,
        status:      { in: [SessionStatus.SCHEDULED, SessionStatus.IN_PROGRESS] },
        scheduledAt: {
          gte: new Date(start.getTime() - 24 * 60 * 60_000),
          lt:  new Date(end.getTime()   + 24 * 60 * 60_000),
        },
      },
      select: { id: true, title: true, scheduledAt: true, duration: true },
    });

    for (const session of candidates) {
      const sessionEnd = new Date(session.scheduledAt.getTime() + session.duration * 60_000);
      if (session.scheduledAt < end && sessionEnd > start) {
        throw new ConflictException(
          `You already have "${session.title}" scheduled at ${new Date(session.scheduledAt).toISOString()} — time slots cannot overlap`,
        );
      }
    }
  }

  private async generateAccessToken(roomId: string, userId: string, isInstructor: boolean, session: any): Promise<string> {
    const apiKey    = this.configService.get<string>('livekit.apiKey');
    const apiSecret = this.configService.get<string>('livekit.apiSecret');

    if (!apiKey || !apiSecret) {
      this.logger.warn('LiveKit credentials missing — returning placeholder token');
      return Buffer.from(JSON.stringify({ roomId, userId, sessionId: session.id })).toString('base64');
    }

    const token = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name:     isInstructor ? 'Instructor' : 'Student',
      ttl:      2 * 60 * 60,
    });

    token.addGrant({
      roomJoin:       true,
      room:           roomId,
      canPublish:     true,
      canSubscribe:   true,
      canPublishData: true,
      ...(isInstructor && { roomAdmin: true }),
    });

    return await token.toJwt();
  }
}
