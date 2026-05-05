import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { VideoStatus } from '@prisma/client';
import * as AWS from 'aws-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import * as path from 'path';
import * as crypto from 'crypto';

interface VideoUploadData {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  lessonId: string;
  userId: string;
}

interface TranscodingOptions {
  quality: '360p' | '480p' | '720p' | '1080p';
  format: 'mp4' | 'hls';
  generateThumbnail: boolean;
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);
  private s3: AWS.S3;
  private cloudFront: AWS.CloudFront;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    @InjectQueue('video-processing') private videoQueue: any,
  ) {
    // Initialize AWS services
    AWS.config.update({
      accessKeyId: this.configService.get('AWS_ACCESS_KEY_ID'),
      secretAccessKey: this.configService.get('AWS_SECRET_ACCESS_KEY'),
      region: this.configService.get('AWS_REGION'),
    });

    this.s3 = new AWS.S3();
    this.cloudFront = new AWS.CloudFront();
  }

  async uploadVideo(uploadData: VideoUploadData) {
    const { originalName, mimeType, size, buffer, lessonId, userId } =
      uploadData;

    // Validate file type
    const allowedMimeTypes = [
      'video/mp4',
      'video/mpeg',
      'video/quicktime',
      'video/x-msvideo', // AVI
      'video/x-ms-wmv', // WMV
    ];

    if (!allowedMimeTypes.includes(mimeType)) {
      throw new BadRequestException('Invalid video file type');
    }

    // Check file size (max 2GB)
    const maxSize = 2 * 1024 * 1024 * 1024; // 2GB
    if (size > maxSize) {
      throw new BadRequestException('File size exceeds 2GB limit');
    }

    // Verify lesson exists and user has permission
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        section: {
          include: {
            course: {
              select: {
                instructorId: true,
                title: true,
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      throw new NotFoundException('Lesson not found');
    }

    if (lesson.section.course.instructorId !== userId) {
      throw new BadRequestException(
        'Not authorized to upload video for this lesson',
      );
    }

    try {
      // Generate unique filename
      const fileId = crypto.randomUUID();
      const extension = path.extname(originalName);
      const filename = `videos/raw/${fileId}${extension}`;

      // Upload to S3
      const uploadParams = {
        Bucket: this.configService.get('AWS_S3_BUCKET'),
        Key: filename,
        Body: buffer,
        ContentType: mimeType,
        ServerSideEncryption: 'AES256',
        Metadata: {
          'original-name': originalName,
          'lesson-id': lessonId,
          'uploaded-by': userId,
          'file-id': fileId,
        },
      };

      const uploadResult = await this.s3.upload(uploadParams).promise();

      // Create video record in database
      const video = await this.prisma.video.create({
        data: {
          id: fileId,
          lessonId,
          originalFilename: originalName,
          filename,
          size: size,
          s3Key: filename,
          originalUrl: uploadResult.Location,
          status: VideoStatus.UPLOADED,
        },
      });

      // Add video processing job to queue
      await this.videoQueue.add(
        'process-video',
        {
          videoId: fileId,
          s3Key: filename,
          originalName,
          lessonId,
        },
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 5000,
          },
          removeOnComplete: 10,
          removeOnFail: 5,
        },
      );

      this.logger.log(`Video uploaded successfully: ${fileId}`);

      return {
        videoId: fileId,
        status: VideoStatus.UPLOADED,
        message: 'Video uploaded successfully and queued for processing',
      };
    } catch (error) {
      this.logger.error(
        `Failed to upload video: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(`Failed to upload video: ${error.message}`);
    }
  }

  async processVideo(
    videoId: string,
    transcodingOptions: TranscodingOptions[],
  ) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.status !== VideoStatus.UPLOADED) {
      throw new BadRequestException('Video is not ready for processing');
    }

    try {
      // Update status to processing
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.PROCESSING,
          processingStartedAt: new Date(),
        },
      });

      // Add processing jobs for each quality
      const processingJobs = transcodingOptions.map((options) =>
        this.videoQueue.add(
          'transcode-video',
          {
            videoId,
            s3Key: video.s3Key,
            quality: options.quality,
            format: options.format,
            generateThumbnail: options.generateThumbnail,
          },
          {
            attempts: 2,
            backoff: {
              type: 'exponential',
              delay: 10000,
            },
          },
        ),
      );

      await Promise.all(processingJobs);

      this.logger.log(`Video processing initiated: ${videoId}`);

      return {
        videoId,
        status: VideoStatus.PROCESSING,
        message: 'Video processing initiated',
      };
    } catch (error) {
      // Update status to failed
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.FAILED,
          errorMessage: error.message,
        },
      });

      this.logger.error(
        `Failed to process video ${videoId}: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Failed to process video: ${error.message}`,
      );
    }
  }

  async transcodeVideo(
    videoId: string,
    s3Key: string,
    quality: string,
    format: string,
    generateThumbnail: boolean = true,
  ) {
    try {
      this.logger.log(`Starting transcoding for video ${videoId} - ${quality}`);

      // This is a placeholder for actual transcoding logic
      // In a real implementation, you would use AWS MediaConvert, Elastic Transcoder,
      // or a service like FFmpeg running in Docker containers

      const outputKey = `videos/processed/${videoId}/${quality}.${format}`;
      const thumbnailKey = generateThumbnail
        ? `videos/thumbnails/${videoId}/thumbnail.jpg`
        : null;

      // Simulate transcoding process
      await this.simulateTranscoding(s3Key, outputKey, quality, format);

      if (generateThumbnail && thumbnailKey) {
        await this.generateThumbnail(s3Key, thumbnailKey);
      }

      // Create video variant record
      const variant = await this.prisma.videoVariant.create({
        data: {
          videoId,
          quality,
          s3Key: outputKey,
          s3Url: this.getCloudFrontUrl(outputKey),
          fileSize: BigInt(0), // Would be populated by actual transcoding service
          bitrate: this.getBitrateForQuality(quality),
          resolution: quality,
        },
      });

      // Update video progress
      await this.updateVideoProgress(videoId);

      this.logger.log(
        `Transcoding completed for video ${videoId} - ${quality}`,
      );

      return variant;
    } catch (error) {
      this.logger.error(
        `Transcoding failed for video ${videoId} - ${quality}: ${error.message}`,
      );
      throw error;
    }
  }

  async getVideoStatus(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: {
          orderBy: { createdAt: 'desc' },
        },
        lesson: {
          select: {
            title: true,
            section: {
              select: {
                title: true,
                courseId: true,
              },
            },
          },
        },
      },
    });

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    const processingProgress = this.calculateProcessingProgress(
      video.status,
      video.variants.length,
    );

    return {
      id: video.id,
      status: video.status,
      originalFilename: video.originalFilename,
      fileSize: video.size,
      duration: video.duration,
      processingProgress,
      uploadedAt: video.createdAt,
      processingStartedAt: video.processingStartedAt,
      processingCompletedAt: video.processingCompletedAt,
      errorMessage: video.errorMessage,
      variants: video.variants.map((variant) => ({
        quality: variant.quality,
        url: variant.s3Url,
        fileSize: variant.fileSize,
        bitrate: variant.bitrate,
        resolution: variant.resolution,
      })),
      lesson: video.lesson
        ? {
            title: video.lesson.title,
            section: video.lesson.section
              ? {
                  title: video.lesson.section.title,
                  courseId: video.lesson.section.courseId,
                }
              : null,
          }
        : null,
    };
  }

  async deleteVideo(videoId: string, userId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: true,
        lesson: {
          include: {
            section: {
              select: { courseId: true },
            },
          },
        },
      },
    });

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    // Note: Permission check simplified due to schema changes
    // TODO: Implement proper permission check through lesson -> section -> course

    try {
      // Delete files from S3
      const deleteObjects = [
        { Key: video.s3Key },
        ...video.variants.map((variant: any) => ({ Key: variant.s3Key })),
      ];

      if (deleteObjects.length > 0) {
        await this.s3
          .deleteObjects({
            Bucket: this.configService.get('AWS_S3_BUCKET') || '',
            Delete: {
              Objects: deleteObjects,
            },
          })
          .promise();
      }

      // Delete from database
      await this.prisma.video.delete({
        where: { id: videoId },
      });

      this.logger.log(`Video deleted: ${videoId}`);

      return { success: true, message: 'Video deleted successfully' };
    } catch (error: any) {
      this.logger.error(`Failed to delete video ${videoId}: ${error.message}`);
      throw new BadRequestException(`Failed to delete video: ${error.message}`);
    }
  }

  async generateSignedUrl(videoId: string, quality: string = '720p') {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: {
          where: { quality },
        },
      },
    });

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    const variant = video.variants.find((v) => v.quality === quality);
    if (!variant) {
      // Fallback to any available variant
      const anyVariant = await this.prisma.videoVariant.findFirst({
        where: { videoId },
        orderBy: { createdAt: 'desc' },
      });

      if (!anyVariant) {
        throw new NotFoundException('No processed video variants found');
      }

      return this.createSignedUrl(anyVariant.s3Key);
    }

    return this.createSignedUrl(variant.s3Key);
  }

  private async simulateTranscoding(
    inputKey: string,
    outputKey: string,
    quality: string,
    format: string,
  ) {
    // This is a placeholder for actual transcoding logic
    // In production, you would integrate with AWS MediaConvert, Elastic Transcoder,
    // or run FFmpeg in containerized environments

    this.logger.log(`Simulating transcoding from ${inputKey} to ${outputKey}`);

    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // In real implementation, you would:
    // 1. Download source video from S3
    // 2. Process with FFmpeg or similar
    // 3. Upload processed video back to S3
    // 4. Extract metadata (duration, bitrate, etc.)
  }

  private async generateThumbnail(inputKey: string, thumbnailKey: string) {
    this.logger.log(`Generating thumbnail for ${inputKey}`);

    // Placeholder for thumbnail generation
    // Would use FFmpeg to extract frame at specific timestamp
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  private async updateVideoProgress(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: true,
      },
    });

    if (!video) {
      return; // Exit early if video not found
    }

    // Check if all expected variants are created
    const expectedQualities = ['360p', '480p', '720p']; // Default qualities
    const completedQualities = video.variants.map((v: any) => v.quality);

    const isComplete = expectedQualities.every((quality) =>
      completedQualities.includes(quality),
    );

    if (isComplete) {
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.READY,
          processingCompletedAt: new Date(),
        },
      });

      // Update lesson video URL with the best quality variant
      const bestVariant =
        video.variants.find((v: any) => v.quality === '720p') ||
        video.variants.find((v: any) => v.quality === '480p') ||
        video.variants[0];

      if (bestVariant && video.lessonId) {
        await this.prisma.lesson.update({
          where: { id: video.lessonId },
          data: {
            videoUrl: bestVariant.s3Url,
            duration: video.duration,
          },
        });
      }
    }
  }

  private calculateProcessingProgress(
    status: VideoStatus,
    variantCount: number,
  ): number {
    switch (status) {
      case VideoStatus.UPLOADED:
        return 10;
      case VideoStatus.PROCESSING:
        return 10 + variantCount * 25; // Assuming 3 variants max
      case VideoStatus.READY:
        return 100;
      case VideoStatus.FAILED:
        return 0;
      default:
        return 0;
    }
  }

  private getBitrateForQuality(quality: string): number {
    const bitrateMap: Record<string, number> = {
      '360p': 800,
      '480p': 1200,
      '720p': 2500,
      '1080p': 5000,
    };
    return bitrateMap[quality as keyof typeof bitrateMap] || 1200;
  }

  private getCloudFrontUrl(s3Key: string): string {
    const cloudFrontDomain = this.configService.get('AWS_CLOUDFRONT_DOMAIN');
    if (cloudFrontDomain) {
      return `https://${cloudFrontDomain}/${s3Key}`;
    }
    return `https://s3.${this.configService.get('AWS_REGION')}.amazonaws.com/${this.configService.get('AWS_S3_BUCKET')}/${s3Key}`;
  }

  private createSignedUrl(s3Key: string): string {
    const params = {
      Bucket: this.configService.get('AWS_S3_BUCKET'),
      Key: s3Key,
      Expires: 3600, // 1 hour
    };

    return this.s3.getSignedUrl('getObject', params);
  }

  // Admin methods
  async getProcessingStats() {
    const [totalVideos, processingVideos, failedVideos, readyVideos] =
      await Promise.all([
        this.prisma.video.count(),
        this.prisma.video.count({ where: { status: VideoStatus.PROCESSING } }),
        this.prisma.video.count({ where: { status: VideoStatus.FAILED } }),
        this.prisma.video.count({ where: { status: VideoStatus.READY } }),
      ]);

    return {
      totalVideos,
      processingVideos,
      failedVideos,
      readyVideos,
      successRate: totalVideos > 0 ? (readyVideos / totalVideos) * 100 : 0,
    };
  }

  async retryFailedVideo(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
    });

    if (!video) {
      throw new NotFoundException('Video not found');
    }

    if (video.status !== VideoStatus.FAILED) {
      throw new BadRequestException('Video is not in failed status');
    }

    // Reset video status and retry processing
    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        status: VideoStatus.UPLOADED,
        errorMessage: null,
        processingStartedAt: null,
        processingCompletedAt: null,
      },
    });

    // Re-queue for processing
    await this.videoQueue.add('process-video', {
      videoId,
      s3Key: video.s3Key,
      originalName: video.originalFilename,
      lessonId: video.lessonId,
    });

    return { success: true, message: 'Video requeued for processing' };
  }
}
