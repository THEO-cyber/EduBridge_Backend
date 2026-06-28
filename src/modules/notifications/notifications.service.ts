import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import { FirebasePushService } from '../../common/firebase/firebase-push.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { NotificationType } from '@prisma/client';
import { NOTIFICATION_QUEUE, NotificationJob } from './notification.queue.processor';

export interface CreateNotificationData {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: any;
  actionUrl?: string;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly useQueue: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsGateway: NotificationsGateway,
    private readonly pushService: FirebasePushService,
    @Optional() @InjectQueue(NOTIFICATION_QUEUE) private readonly notifQueue?: any,
  ) {
    this.useQueue = !!notifQueue && process.env.REDIS_AVAILABLE === 'true';
  }

  // ─── Device token management ────────────────────────────────────────────────

  async saveDeviceToken(
    userId: string,
    token: string,
    platform: 'android' | 'ios' | 'web' = 'android',
  ) {
    await this.prisma.deviceToken.upsert({
      where: { userId_token: { userId, token } },
      create: { userId, token, platform },
      update: { platform, updatedAt: new Date() },
    });
    return { success: true };
  }

  async removeDeviceToken(userId: string, token: string) {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
    return { success: true };
  }

  private async removeStaleTokens(tokens: string[]) {
    if (tokens.length === 0) return;
    await this.prisma.deviceToken.deleteMany({ where: { token: { in: tokens } } });
  }

  private async getUserFcmTokens(userId: string): Promise<string[]> {
    const records = await this.prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return records.map((r) => r.token);
  }

  // ─── Core notification dispatch ─────────────────────────────────────────────
  // When Redis is available: notification creation + push are offloaded to the
  // BullMQ worker so the caller's request is never delayed by FCM latency.
  // When Redis is unavailable: falls back to synchronous creation (same as before).

  async createNotification(data: CreateNotificationData) {
    if (this.useQueue && this.notifQueue) {
      await this.notifQueue.add(
        'create-notification',
        {
          userId:    data.userId,
          type:      data.type,
          title:     data.title,
          message:   data.message,
          actionUrl: data.actionUrl,
          metadata:  data.data,
        },
        { attempts: 2, backoff: { type: 'fixed', delay: 3_000 }, removeOnComplete: 100, removeOnFail: 50 },
      );
      return { queued: true };
    }

    // Synchronous fallback
    const notification = await this.prisma.notification.create({
      data: {
        userId:    data.userId,
        type:      data.type,
        title:     data.title,
        message:   data.message,
        metadata:  data.data,
        actionUrl: data.actionUrl,
      },
    });

    if (this.notificationsGateway.isUserConnected(data.userId)) {
      this.notificationsGateway.sendNotificationToUser(data.userId, notification);
    } else {
      this.sendPush(data.userId, data.title, data.message, data.data).catch(() => {});
    }

    return notification;
  }

  async createBulkNotifications(notifications: CreateNotificationData[]) {
    if (this.useQueue && this.notifQueue) {
      const jobs = notifications.map((n) => ({
        name: 'create-notification' as const,
        data: {
          userId:    n.userId,
          type:      n.type,
          title:     n.title,
          message:   n.message,
          actionUrl: n.actionUrl,
          metadata:  n.data,
        },
        opts: { attempts: 2, backoff: { type: 'fixed', delay: 3_000 }, removeOnComplete: 100, removeOnFail: 50 },
      }));
      await this.notifQueue.addBulk(jobs);
      return { queued: notifications.length };
    }

    // Synchronous fallback
    const result = await this.prisma.notification.createMany({
      data: notifications.map((n) => ({
        userId:    n.userId,
        type:      n.type,
        title:     n.title,
        message:   n.message,
        metadata:  n.data,
        actionUrl: n.actionUrl,
      })),
      skipDuplicates: true,
    });

    for (const n of notifications) {
      const saved = await this.prisma.notification.findFirst({
        where: { userId: n.userId, type: n.type, title: n.title },
        orderBy: { createdAt: 'desc' },
      });
      if (saved) {
        if (this.notificationsGateway.isUserConnected(n.userId)) {
          this.notificationsGateway.sendNotificationToUser(n.userId, saved);
        } else {
          this.sendPush(n.userId, n.title, n.message, n.data).catch(() => {});
        }
      }
    }

    return result;
  }

  // ─── FCM sender (internal) ──────────────────────────────────────────────────

  private async sendPush(
    userId: string,
    title: string,
    body: string,
    data?: Record<string, any>,
  ) {
    const tokens = await this.getUserFcmTokens(userId);
    if (tokens.length === 0) return;

    // Stringify data values — FCM only accepts string values
    const stringData: Record<string, string> = {};
    if (data) {
      for (const [k, v] of Object.entries(data)) {
        stringData[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
    }

    const { staleTokens } = await this.pushService.sendToTokens(tokens, {
      title,
      body,
      data: stringData,
    });

    await this.removeStaleTokens(staleTokens);
  }

  // ─── Read / delete ──────────────────────────────────────────────────────────

  async getUserNotifications(
    userId: string,
    paginationDto: PaginationDto,
    unreadOnly = false,
  ) {
    const { page, limit, skip } = paginationDto;
    const where: any = { userId };
    if (unreadOnly) where.isRead = false;

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return {
      notifications,
      unreadCount,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / (limit || 20)),
      },
    };
  }

  async markAsRead(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.isRead) throw new BadRequestException('Already read');

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });
  }

  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
    return { markedCount: result.count };
  }

  async deleteNotification(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    await this.prisma.notification.delete({ where: { id: notificationId } });
    return { success: true };
  }

  // ─── Admin broadcast ────────────────────────────────────────────────────────

  async broadcastToRole(
    role: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN' | 'ALL',
    title: string,
    message: string,
    data?: Record<string, any>,
    actionUrl?: string,
  ) {
    const where = role === 'ALL' ? { isActive: true } : { role: role as any, isActive: true };
    const users = await this.prisma.user.findMany({ where, select: { id: true } });

    if (users.length === 0) return { sent: 0 };

    const type = NotificationType.SYSTEM_ALERT;
    const batchId = randomUUID();
    await this.prisma.notification.createMany({
      data: users.map((u) => ({
        userId: u.id, type, title, message, actionUrl,
        metadata: { ...(data ?? {}), batchId },
      })),
      skipDuplicates: true,
    });

    for (const u of users) {
      if (this.notificationsGateway.isUserConnected(u.id)) {
        this.notificationsGateway.sendNotificationToUser(u.id, { title, message, type, data, actionUrl });
      } else {
        this.sendPush(u.id, title, message, data).catch(() => {});
      }
    }

    return { sent: users.length, batchId };
  }

  async broadcastToUsers(
    userIds: string[],
    title: string,
    message: string,
    data?: Record<string, any>,
    actionUrl?: string,
  ) {
    if (userIds.length === 0) return { sent: 0 };

    const type = NotificationType.SYSTEM_ALERT;
    const batchId = randomUUID();
    await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId, type, title, message, actionUrl,
        metadata: { ...(data ?? {}), batchId },
      })),
      skipDuplicates: true,
    });

    for (const userId of userIds) {
      if (this.notificationsGateway.isUserConnected(userId)) {
        this.notificationsGateway.sendNotificationToUser(userId, { title, message, type, data, actionUrl });
      } else {
        this.sendPush(userId, title, message, data).catch(() => {});
      }
    }

    return { sent: userIds.length, batchId };
  }

  // ─── Typed helpers ──────────────────────────────────────────────────────────

  async notifyEnrollmentSuccess(userId: string, courseTitle: string, courseId: string) {
    return this.createNotification({
      userId,
      type: NotificationType.ENROLLMENT,
      title: 'Course Enrollment Successful',
      message: `You have successfully enrolled in "${courseTitle}"`,
      data: { courseId },
      actionUrl: `/courses/${courseId}`,
    });
  }

  async notifyLessonCompleted(
    userId: string,
    lessonTitle: string,
    courseTitle: string,
    lessonId: string,
    courseId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.PROGRESS,
      title: 'Lesson Completed',
      message: `You completed "${lessonTitle}" in ${courseTitle}`,
      data: { lessonId, courseId },
    });
  }

  async notifyCourseCompleted(userId: string, courseTitle: string, courseId: string) {
    return this.createNotification({
      userId,
      type: NotificationType.PROGRESS,
      title: 'Course Completed! 🎉',
      message: `Congratulations! You completed "${courseTitle}". Your certificate is ready.`,
      data: { courseId, certificateAvailable: true },
      actionUrl: `/certificates`,
    });
  }

  async notifyLiveSessionScheduled(
    userId: string,
    sessionTitle: string,
    instructorName: string,
    sessionDate: Date,
    sessionId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.LIVE_SESSION,
      title: 'Live Session Confirmed',
      message: `"${sessionTitle}" with ${instructorName} on ${sessionDate.toLocaleDateString()}`,
      data: { sessionId, sessionDate: sessionDate.toISOString() },
      actionUrl: `/sessions/${sessionId}`,
    });
  }

  async notifyLiveSessionStarting(userId: string, sessionTitle: string, sessionId: string) {
    return this.createNotification({
      userId,
      type: NotificationType.LIVE_SESSION,
      title: 'Session Starting Soon ⏰',
      message: `"${sessionTitle}" starts in 15 minutes`,
      data: { sessionId, urgent: 'true' },
      actionUrl: `/sessions/${sessionId}/join`,
    });
  }

  async notifyPaymentSuccess(
    userId: string,
    courseTitle: string,
    amount: number,
    currency: string,
    paymentId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.PAYMENT_SUCCESS,
      title: 'Payment Successful',
      message: `${currency.toUpperCase()} ${amount.toFixed(2)} for "${courseTitle}" — receipt ready`,
      data: { paymentId, amount: String(amount), currency },
      actionUrl: `/payments/history`,
    });
  }

  async notifyInstructorPayout(
    instructorId: string,
    amount: number,
    currency: string,
    courseTitle: string,
    payoutId: string,
  ) {
    return this.createNotification({
      userId: instructorId,
      type: NotificationType.PAYOUT,
      title: 'Payout Processed',
      message: `${currency.toUpperCase()} ${amount.toFixed(2)} from "${courseTitle}" sales`,
      data: { payoutId, amount: String(amount), currency },
    });
  }

  async notifyNewMessage(
    userId: string,
    senderName: string,
    messagePreview: string,
    chatId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.CHAT_MESSAGE,
      title: `New message from ${senderName}`,
      message:
        messagePreview.length > 50
          ? `${messagePreview.substring(0, 47)}…`
          : messagePreview,
      data: { senderName, chatId },
      actionUrl: `/chat/${chatId}`,
    });
  }
}
