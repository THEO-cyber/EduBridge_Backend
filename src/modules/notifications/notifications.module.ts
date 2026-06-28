import { Module, Logger } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsGateway } from './notifications.gateway';
import { NotificationQueueProcessor, NOTIFICATION_QUEUE } from './notification.queue.processor';
import { FirebaseModule } from '../../common/firebase/firebase.module';

const redisAvailable = process.env.REDIS_AVAILABLE === 'true';

if (!redisAvailable) {
  new Logger('NotificationsModule').warn(
    'Redis unavailable — notifications will be created synchronously (no queue)',
  );
}

@Module({
  imports: [
    JwtModule,
    FirebaseModule,
    BullModule.registerQueue({ name: NOTIFICATION_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsGateway,
    ...(redisAvailable ? [NotificationQueueProcessor] : []),
  ],
  exports: [NotificationsService, NotificationsGateway],
})
export class NotificationsModule {}
