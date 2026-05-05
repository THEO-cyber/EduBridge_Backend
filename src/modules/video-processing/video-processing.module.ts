import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VideoProcessingController } from './video-processing.controller';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessingProcessor } from './video-processing.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'video-processing',
    }),
  ],
  controllers: [VideoProcessingController],
  providers: [VideoProcessingService, VideoProcessingProcessor],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
