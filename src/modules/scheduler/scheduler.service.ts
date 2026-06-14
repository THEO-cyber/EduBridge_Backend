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
      const student    = session.student    as any;

      await Promise.allSettled([
        this.notificationsService.notifyLiveSessionStarting(instructor.id, session.title, session.id),
        this.notificationsService.notifyLiveSessionStarting(student.id, session.title, session.id),
        instructor.email
          ? this.emailService.sendSessionReminder(instructor.email, `${instructor.firstName} ${instructor.lastName}`, session.title, 15, session.id, frontendUrl)
          : Promise.resolve(),
        student.email
          ? this.emailService.sendSessionReminder(student.email, `${student.firstName} ${student.lastName}`, session.title, 15, session.id, frontendUrl)
          : Promise.resolve(),
      ]);
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

  // ── Mark overdue sessions as NO_SHOW — runs every 30 minutes ─────────────

  @Cron('*/30 * * * *')
  async markOverdueSessions() {
    const cutoff = new Date(Date.now() - 60 * 60_000);

    const overdue = await this.prisma.liveSession.updateMany({
      where: { status: SessionStatus.SCHEDULED, scheduledAt: { lt: cutoff } },
      data:  { status: SessionStatus.NO_SHOW },
    });

    if (overdue.count > 0) {
      this.logger.log(`Marked ${overdue.count} overdue session(s) as NO_SHOW`);
    }
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
