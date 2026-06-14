import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LiveSessionsController } from './live-sessions.controller';
import { LiveSessionsService } from './live-sessions.service';
import { AvailabilityService } from './availability.service';
import { ClassroomGateway } from './classroom.gateway';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../../common/email/email.module';

@Module({
  imports: [NotificationsModule, EmailModule, JwtModule],
  controllers: [LiveSessionsController],
  providers: [LiveSessionsService, AvailabilityService, ClassroomGateway],
  exports: [LiveSessionsService, AvailabilityService, ClassroomGateway],
})
export class LiveSessionsModule {}
