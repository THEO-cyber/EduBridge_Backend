import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PublicSettingsController } from './public-settings.controller';
import { AdminService } from './admin.service';
import { SystemSettingsService } from './system-settings.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailModule } from '../../common/email/email.module';
import { VideoProcessingModule } from '../video-processing/video-processing.module';

@Module({
  imports: [NotificationsModule, EmailModule, VideoProcessingModule],
  controllers: [AdminController, PublicSettingsController],
  providers: [AdminService, SystemSettingsService],
  exports: [AdminService, SystemSettingsService],
})
export class AdminModule {}
