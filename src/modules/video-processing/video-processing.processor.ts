import { WorkerHost, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VideoProcessingService, TranscodingOptions } from './video-processing.service';

// concurrency: how many jobs this worker runs in parallel.
// Cast needed because @nestjs/bullmq v10 narrows the type but bullmq v5 supports it.
@Processor('video-processing', { concurrency: 10 } as any)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: any): Promise<any> {
    switch (job.name) {
      case 'process-video':
        return this.handleProcessVideo(job);
      case 'transcode-video':
        return this.handleTranscodeVideo(job);
      case 'cleanup-failed-videos':
        return this.handleCleanupFailedVideos(job);
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }

  private async handleProcessVideo(job: any) {
    const { videoId } = job.data;
    this.logger.log(`Processing video: ${videoId}`);

    await job.updateProgress(10);

    const transcodingOptions: TranscodingOptions[] = [
      { quality: '360p',  format: 'mp4', generateThumbnail: true  },
      { quality: '480p',  format: 'mp4', generateThumbnail: false },
      { quality: '720p',  format: 'mp4', generateThumbnail: false },
    ];

    await job.updateProgress(20);

    await this.videoProcessingService.processVideo(videoId, transcodingOptions);

    await job.updateProgress(100);
    this.logger.log(`Video processing jobs queued for: ${videoId}`);
    return { success: true, videoId };
  }

  private async handleTranscodeVideo(job: any) {
    const { videoId, s3Key, quality, format, generateThumbnail } = job.data;
    this.logger.log(`Transcoding ${videoId} → ${quality} (${format})`);

    await job.updateProgress(0);

    try {
      const variant = await this.videoProcessingService.transcodeVideo(
        videoId,
        s3Key,
        quality,
        format,
        generateThumbnail,
      );

      await job.updateProgress(100);
      this.logger.log(`Transcoded ${videoId} → ${quality}`);
      return { success: true, videoId, quality, variantId: variant.id };
    } catch (error: any) {
      this.logger.error(`Transcode failed ${videoId} → ${quality}: ${error.message}`, error.stack);
      // Mark video as failed after all retries exhausted
      if (job.attemptsMade >= (job.opts?.attempts ?? 1) - 1) {
        await this.videoProcessingService.markVideoFailed(videoId, error.message);
      }
      throw error;
    }
  }

  private async handleCleanupFailedVideos(job: any) {
    const { maxAgeHours = 24 } = job.data || {};
    this.logger.log(`Cleaning up failed videos older than ${maxAgeHours}h`);
    // Actual cleanup is handled via DB query in VideoProcessingService
    // This job exists to be scheduled via BullMQ cron
    return { success: true };
  }
}
