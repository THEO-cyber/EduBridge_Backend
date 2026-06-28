import { WorkerHost, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsGateway } from './notifications.gateway';
import { FirebasePushService } from '../../common/firebase/firebase-push.service';
import { NotificationType } from '@prisma/client';

export const NOTIFICATION_QUEUE = 'notification';

export interface NotificationJob {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  actionUrl?: string;
  metadata?: Record<string, any>;
}

@Processor(NOTIFICATION_QUEUE, { concurrency: 20 } as any)
export class NotificationQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationQueueProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
    private readonly pushService: FirebasePushService,
  ) {
    super();
  }

  async process(job: any): Promise<void> {
    const { userId, type, title, message, actionUrl, metadata } = job.data as NotificationJob;

    const notification = await this.prisma.notification.create({
      data: { userId, type, title, message, actionUrl, metadata },
    });

    if (this.gateway.isUserConnected(userId)) {
      this.gateway.sendNotificationToUser(userId, notification);
    } else {
      const tokens = await this.prisma.deviceToken.findMany({
        where: { userId },
        select: { token: true },
      });
      if (tokens.length > 0) {
        await this.pushService
          .sendToTokens(tokens.map((t) => t.token), { title, body: message, data: metadata })
          .catch((e) => this.logger.warn(`FCM push failed for ${userId}: ${e.message}`));
      }
    }
  }
}
