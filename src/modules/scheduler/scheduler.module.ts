import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../../common/email/email.module';

@Module({
  imports: [NotificationsModule, EmailModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
