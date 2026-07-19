import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../../common/email/email.service';
import { SessionStatus, VideoStatus } from '@prisma/client';

@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  // ── Session reminders — runs every minute ──────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async sendSessionReminders() {
    const now  = new Date();
    const in15 = new Date(now.getTime() + 15 * 60_000);
    const in16 = new Date(now.getTime() + 16 * 60_000);

    const upcoming = await this.prisma.liveSession.findMany({
      where: {
        status:      SessionStatus.SCHEDULED,
        scheduledAt: { gte: in15, lt: in16 },
      },
      include: {
        instructor: { select: { id: true, email: true, firstName: true, lastName: true } },
        student:    { select: { id: true, email: true, firstName: true, lastName: true } },
      },
    });

    if (upcoming.length === 0) return;
    this.logger.log(`Sending reminders for ${upcoming.length} upcoming session(s)`);

    const frontendUrl = process.env.FRONTEND_URL?.split(',')[0] ?? '';

    for (const session of upcoming) {
      const instructor = session.instructor as any;

      // Recipients = the 1-on-1 student (if any) PLUS every student accepted
      // into a group session (SessionRequest with status IN_PROGRESS). Without
      // this, group-session attendees never get the "class is starting" push.
      const accepted = await this.prisma.sessionRequest.findMany({
        where:   { liveSessionId: session.id, status: SessionStatus.IN_PROGRESS } as any,
        include: { student: { select: { id: true, email: true, firstName: true, lastName: true } } },
      });

      const studentsById = new Map<string, any>();
      if (session.student) studentsById.set((session.student as any).id, session.student);
      for (const a of accepted) {
        const s = (a as any).student;
        if (s?.id) studentsById.set(s.id, s);
      }

      const tasks: Promise<any>[] = [
        this.notificationsService.notifyLiveSessionStarting(instructor.id, session.title, session.id),
      ];
      if (instructor.email) {
        tasks.push(this.emailService.sendSessionReminder(
          instructor.email, `${instructor.firstName} ${instructor.lastName}`, session.title, 15, session.id, frontendUrl,
        ));
      }
      for (const s of studentsById.values()) {
        tasks.push(this.notificationsService.notifyLiveSessionStarting(s.id, session.title, session.id));
        if (s.email) {
          tasks.push(this.emailService.sendSessionReminder(
            s.email, `${s.firstName} ${s.lastName}`, session.title, 15, session.id, frontendUrl,
          ));
        }
      }

      await Promise.allSettled(tasks);
    }
  }

  // ── Failed video cleanup — runs every 6 hours ─────────────────────────────

  @Cron('0 */6 * * *')
  async cleanupStalledVideos() {
    const cutoff = new Date(Date.now() - 2 * 60 * 60_000);

    const stalled = await this.prisma.video.updateMany({
      where: { status: VideoStatus.PROCESSING, processingStartedAt: { lt: cutoff } },
      data:  { status: VideoStatus.FAILED, errorMessage: 'Processing timed out — please retry' },
    });

    if (stalled.count > 0) {
      this.logger.warn(`Marked ${stalled.count} stalled video(s) as FAILED`);
    }
  }

  // ── Remove ended / expired live sessions — runs every 15 minutes ──────────
  // A class is deleted (not archived) once it is over, so instructors never
  // accumulate completed/expired sessions and simply create a fresh one.

  @Cron('*/15 * * * *')
  async cleanupEndedSessions() {
    const now = Date.now();
    const graceMs = 45 * 60_000; // allow a class to run up to 45 min past its scheduled end

    // Candidates: any terminal-status session, or one whose start time has passed.
    const candidates = await this.prisma.liveSession.findMany({
      where: {
        OR: [
          { status: { in: [SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.NO_SHOW] } },
          { scheduledAt: { lt: new Date(now) } },
        ],
      },
      select: { id: true, scheduledAt: true, duration: true, status: true },
    });

    const terminal: SessionStatus[] = [SessionStatus.COMPLETED, SessionStatus.CANCELLED, SessionStatus.NO_SHOW];
    const toDelete = candidates
      .filter((s) => {
        if (terminal.includes(s.status)) return true; // already over
        // SCHEDULED/IN_PROGRESS: gone once the class window + grace has passed.
        const endMs = new Date(s.scheduledAt).getTime() + (s.duration ?? 60) * 60_000 + graceMs;
        return now > endMs;
      })
      .map((s) => s.id);

    if (toDelete.length === 0) return;

    await this.prisma.$transaction([
      this.prisma.sessionRequest.deleteMany({ where: { liveSessionId: { in: toDelete } } as any }),
      this.prisma.liveSession.deleteMany({ where: { id: { in: toDelete } } }),
    ]);

    this.logger.log(`Removed ${toDelete.length} ended/expired live session(s)`);
  }

  // ── Delete old notifications — runs daily at 3 AM ─────────────────────────

  @Cron('0 3 * * *')
  async cleanupOldNotifications() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60_000);

    const deleted = await this.prisma.notification.deleteMany({
      where: { isRead: true, createdAt: { lt: thirtyDaysAgo } },
    });

    if (deleted.count > 0) {
      this.logger.log(`Deleted ${deleted.count} old read notifications`);
    }
  }

  // ── Refresh instructor ratings — GROUP BY, O(1) queries, runs every hour ──

  @Cron(CronExpression.EVERY_HOUR)
  async refreshInstructorRatings() {
    // Single aggregated query instead of N queries in a loop
    const stats = await this.prisma.$queryRaw<
      Array<{ instructorId: string; avgRating: number; totalReviews: bigint }>
    >`
      SELECT
        c."instructorId",
        AVG(r.rating)::float   AS "avgRating",
        COUNT(r.id)            AS "totalReviews"
      FROM "Course" c
      LEFT JOIN "Review" r ON r."courseId" = c.id
      GROUP BY c."instructorId"
    `;

    if (stats.length === 0) return;

    // Batch update using upsert-friendly updateMany per profile
    await Promise.all(
      stats.map(({ instructorId, avgRating, totalReviews }) =>
        this.prisma.instructorProfile.updateMany({
          where: { userId: instructorId },
          data: {
            rating:       avgRating ?? 0,
            totalReviews: Number(totalReviews),
          },
        }),
      ),
    );

    this.logger.debug(`Refreshed ratings for ${stats.length} instructor(s)`);
  }

  // ── Sync course stats — GROUP BY, 4 queries total regardless of course count ──

  @Cron('0 4 * * *')
  async syncCourseStats() {
    // Enrollment counts per course (active only)
    const enrollmentCounts = await this.prisma.$queryRaw<
      Array<{ courseId: string; total: bigint }>
    >`
      SELECT "courseId", COUNT(*) AS total
      FROM "Enrollment"
      WHERE status = 'ACTIVE'
      GROUP BY "courseId"
    `;

    // Revenue per course
    const revenues = await this.prisma.$queryRaw<
      Array<{ courseId: string; total: number }>
    >`
      SELECT "courseId", COALESCE(SUM(price::numeric), 0) AS total
      FROM "Enrollment"
      GROUP BY "courseId"
    `;

    // Ratings and review counts per course
    const ratings = await this.prisma.$queryRaw<
      Array<{ courseId: string; avgRating: number; totalReviews: bigint }>
    >`
      SELECT
        "courseId",
        COALESCE(AVG(rating)::float, 0) AS "avgRating",
        COUNT(*)                         AS "totalReviews"
      FROM "Review"
      GROUP BY "courseId"
    `;

    // Index for O(1) lookup
    const enrollmentMap = new Map(enrollmentCounts.map(r => [r.courseId, Number(r.total)]));
    const revenueMap    = new Map(revenues.map(r => [r.courseId, r.total]));
    const ratingMap     = new Map(ratings.map(r => [r.courseId, r]));

    const courses = await this.prisma.course.findMany({ select: { id: true } });

    await Promise.all(
      courses.map(({ id }) =>
        this.prisma.course.update({
          where: { id },
          data: {
            totalEnrollments: enrollmentMap.get(id) ?? 0,
            totalRevenue:     revenueMap.get(id) ?? 0,
            rating:           ratingMap.get(id)?.avgRating ?? 0,
            totalReviews:     Number(ratingMap.get(id)?.totalReviews ?? 0),
          },
        }),
      ),
    );

    this.logger.log(`Synced stats for ${courses.length} course(s) using 4 aggregate queries`);
  }
}
