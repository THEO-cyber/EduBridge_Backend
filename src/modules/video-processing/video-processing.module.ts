import { Module, Logger } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { VideoProcessingController } from './video-processing.controller';
import { VideoProcessingService } from './video-processing.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { probeRedis } from '../../common/redis/redis-connection.factory';

// Probe once at module load time and cache the result.
// main.ts calls probeRedis before NestFactory.create, so by the time this
// module is evaluated process.env.REDIS_AVAILABLE is already set.
const redisAvailable = process.env.REDIS_AVAILABLE === 'true';

if (!redisAvailable) {
  new Logger('VideoProcessingModule').warn(
    'Redis unavailable — video processing Worker is disabled. ' +
    'Videos will remain in UPLOADED status until Redis is connected.',
  );
}

@Module({
  imports: [
    BullModule.registerQueue({ name: 'video-processing' }),
  ],
  controllers: [VideoProcessingController],
  providers: [
    VideoProcessingService,
    // Only register the BullMQ worker/processor when Redis is reachable.
    // Without this guard the Worker polls in a tight loop and spams Lua errors.
    ...(redisAvailable ? [VideoProcessingProcessor] : []),
  ],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
