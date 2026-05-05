import { WorkerHost, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { VideoProcessingService } from './video-processing.service';

interface TranscodingOptions {
  quality: '360p' | '480p' | '720p' | '1080p';
  format: 'mp4' | 'hls';
  generateThumbnail: boolean;
}

@Processor('video-processing')
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private videoProcessingService: VideoProcessingService) {
    super();
  }

  async process(job: any): Promise<any> {
    switch (job.name) {
      case 'process-video':
        return this.processVideo(job);
      case 'transcode-video':
        return this.transcodeVideo(job);
      case 'cleanup-failed-videos':
        return this.cleanupFailedVideos(job);
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }

  async processVideo(job: any) {
    const { videoId, s3Key, originalName, lessonId } = job.data;

    this.logger.log(`Processing video job for video ID: ${videoId}`);

    try {
      // Update job progress
      await job.progress(10);

      // Default processing options
      const transcodingOptions: TranscodingOptions[] = [
        { quality: '360p', format: 'mp4', generateThumbnail: true },
        { quality: '480p', format: 'mp4', generateThumbnail: false },
        { quality: '720p', format: 'mp4', generateThumbnail: false },
      ];

      await job.progress(20);

      // Process video with default options
      await this.videoProcessingService.processVideo(
        videoId,
        transcodingOptions,
      );

      await job.progress(100);

      this.logger.log(`Video processing completed for video ID: ${videoId}`);

      return { success: true, videoId };
    } catch (error) {
      this.logger.error(
        `Video processing failed for video ID: ${videoId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async transcodeVideo(job: any) {
    const { videoId, s3Key, quality, format, generateThumbnail } = job.data;

    this.logger.log(`Transcoding video ${videoId} to ${quality}`);

    try {
      await job.progress(0);

      const variant = await this.videoProcessingService.transcodeVideo(
        videoId,
        s3Key,
        quality,
        format,
        generateThumbnail,
      );

      await job.progress(100);

      this.logger.log(
        `Transcoding completed for video ${videoId} - ${quality}`,
      );

      return {
        success: true,
        videoId,
        quality,
        variantId: variant.id,
      };
    } catch (error) {
      this.logger.error(
        `Transcoding failed for video ${videoId} - ${quality}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }

  async cleanupFailedVideos(job: any) {
    this.logger.log('Starting cleanup of failed videos');

    try {
      // This would contain logic to clean up failed video processing jobs
      // For example, removing temporary files, updating database status, etc.

      const { maxAge = 24 } = job.data; // hours
      const cutoffDate = new Date(Date.now() - maxAge * 60 * 60 * 1000);

      // Implementation would go here to clean up failed videos older than cutoffDate

      this.logger.log('Failed videos cleanup completed');

      return { success: true, cleanedUp: 0 }; // Would return actual count
    } catch (error) {
      this.logger.error('Failed videos cleanup failed', error instanceof Error ? error.stack : String(error));
      throw error;
    }
  }
}
