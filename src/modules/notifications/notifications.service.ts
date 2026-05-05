import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { NotificationType } from '@prisma/client';

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
  constructor(
    private prisma: PrismaService,
    private notificationsGateway: NotificationsGateway,
  ) {}

  async createNotification(notificationData: CreateNotificationData) {
    const notification = await this.prisma.notification.create({
      data: {
        userId: notificationData.userId,
        type: notificationData.type,
        title: notificationData.title,
        message: notificationData.message,
        metadata: notificationData.data,
        actionUrl: notificationData.actionUrl,
      },
    });

    // Send real-time notification via Socket.IO
    this.notificationsGateway.sendNotificationToUser(
      notificationData.userId,
      notification,
    );

    return notification;
  }

  async createBulkNotifications(notifications: CreateNotificationData[]) {
    const createdNotifications = await this.prisma.notification.createMany({
      data: notifications,
      skipDuplicates: true,
    });

    // Send notifications to all users in bulk
    for (const notification of notifications) {
      const savedNotification = await this.prisma.notification.findFirst({
        where: {
          userId: notification.userId,
          type: notification.type,
          title: notification.title,
        },
        orderBy: { createdAt: 'desc' },
      });

      if (savedNotification) {
        this.notificationsGateway.sendNotificationToUser(
          notification.userId,
          savedNotification,
        );
      }
    }

    return createdNotifications;
  }

  async getUserNotifications(
    userId: string,
    paginationDto: PaginationDto,
    unreadOnly: boolean = false,
  ) {
    const { page, limit, skip } = paginationDto;

    const where: any = { userId };
    if (unreadOnly) {
      where.isRead = false;
    }

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: { userId, isRead: false },
      }),
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
      where: {
        id: notificationId,
        userId,
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    if (notification.isRead) {
      throw new BadRequestException('Notification already marked as read');
    }

    const updatedNotification = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { isRead: true },
    });

    return updatedNotification;
  }

  async markAllAsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        isRead: false,
      },
      data: {
        isRead: true,
      },
    });

    return { markedCount: result.count };
  }

  async deleteNotification(userId: string, notificationId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        userId,
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    return { success: true };
  }

  // Helper methods for common notification types
  async notifyEnrollmentSuccess(
    userId: string,
    courseTitle: string,
    courseId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.ENROLLMENT,
      title: 'Course Enrollment Successful',
      message: `You have successfully enrolled in "${courseTitle}"`,
      data: { courseId },
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

  async notifyCourseCompleted(
    userId: string,
    courseTitle: string,
    courseId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.PROGRESS,
      title: 'Course Completed!',
      message: `Congratulations! You completed "${courseTitle}". Your certificate is ready.`,
      data: { courseId, certificateAvailable: true },
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
      title: 'Live Session Scheduled',
      message: `Your session "${sessionTitle}" with ${instructorName} is scheduled for ${sessionDate.toLocaleDateString()}`,
      data: { sessionId, sessionDate: sessionDate.toISOString() },
    });
  }

  async notifyLiveSessionStarting(
    userId: string,
    sessionTitle: string,
    sessionId: string,
  ) {
    return this.createNotification({
      userId,
      type: NotificationType.LIVE_SESSION,
      title: 'Session Starting Soon',
      message: `Your session "${sessionTitle}" starts in 15 minutes`,
      data: { sessionId, urgent: true },
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
      message: `Payment of ${currency.toUpperCase()} ${amount.toFixed(2)} for "${courseTitle}" was successful`,
      data: { paymentId, amount, currency },
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
      message: `You received ${currency.toUpperCase()} ${amount.toFixed(2)} from "${courseTitle}" sales`,
      data: { payoutId, amount, currency },
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
          ? messagePreview.substring(0, 47) + '...'
          : messagePreview,
      data: { senderName, chatId },
    });
  }
}
