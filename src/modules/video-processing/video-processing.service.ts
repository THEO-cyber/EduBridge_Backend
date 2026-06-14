import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { VideoStatus } from '@prisma/client';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InjectQueue } from '@nestjs/bullmq';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as crypto from 'crypto';
// fluent-ffmpeg uses `export =` so we need `import =` for a callable reference
import ffmpeg = require('fluent-ffmpeg');
// ffmpeg-static ships a CJS default export that is the binary path string
import ffmpegStatic = require('ffmpeg-static');

// Tell fluent-ffmpeg where the bundled binary lives
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic as unknown as string);
}

export interface VideoUploadData {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  lessonId: string;
  userId: string;
}

export interface TranscodingOptions {
  quality: '360p' | '480p' | '720p' | '1080p';
  format: 'mp4' | 'hls';
  generateThumbnail: boolean;
}

interface QualityProfile {
  resolution: string;
  videoBitrate: string;
  audioBitrate: string;
  width: number;
  height: number;
}

const QUALITY_PROFILES: Record<string, QualityProfile> = {
  '360p':  { resolution: '640x360',   videoBitrate: '800k',  audioBitrate: '96k',  width: 640,  height: 360  },
  '480p':  { resolution: '854x480',   videoBitrate: '1200k', audioBitrate: '128k', width: 854,  height: 480  },
  '720p':  { resolution: '1280x720',  videoBitrate: '2500k', audioBitrate: '128k', width: 1280, height: 720  },
  '1080p': { resolution: '1920x1080', videoBitrate: '5000k', audioBitrate: '192k', width: 1920, height: 1080 },
};

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);
  private s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly cloudFrontDomain?: string;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    @InjectQueue('video-processing') private videoQueue: any,
  ) {
    this.region = this.configService.get<string>('aws.region') || 'us-east-1';
    this.bucket = this.configService.get<string>('aws.s3Bucket') || '';
    this.cloudFrontDomain = this.configService.get<string>('AWS_CLOUDFRONT_DOMAIN');

    // S3_ENDPOINT: set to MinIO URL (e.g. http://minio:9000) to use MinIO instead of AWS S3.
    // Leave blank to use real AWS S3.
    const s3Endpoint = this.configService.get<string>('S3_ENDPOINT');

    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: this.configService.get<string>('aws.accessKeyId') || '',
        secretAccessKey: this.configService.get<string>('aws.secretAccessKey') || '',
      },
      ...(s3Endpoint ? {
        endpoint: s3Endpoint,
        forcePathStyle: true, // required for MinIO — uses /bucket/key instead of bucket.host/key
      } : {}),
    });
  }

  async uploadVideo(uploadData: VideoUploadData) {
    const { originalName, mimeType, size, buffer, lessonId, userId } = uploadData;

    const allowedMimeTypes = [
      'video/mp4', 'video/mpeg', 'video/quicktime',
      'video/x-msvideo', 'video/x-ms-wmv', 'video/webm',
      'video/x-matroska',
    ];

    if (!allowedMimeTypes.includes(mimeType)) {
      throw new BadRequestException(`Unsupported video type: ${mimeType}`);
    }

    const maxSize = 2 * 1024 * 1024 * 1024; // 2 GB
    if (size > maxSize) {
      throw new BadRequestException('File size exceeds the 2 GB limit');
    }

    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: {
        section: {
          include: {
            course: { select: { instructorId: true, title: true } },
          },
        },
      },
    });

    if (!lesson) throw new NotFoundException('Lesson not found');

    if (lesson.section.course.instructorId !== userId) {
      throw new BadRequestException('Not authorized to upload video for this lesson');
    }

    try {
      const fileId = crypto.randomUUID();
      const extension = path.extname(originalName).toLowerCase() || '.mp4';
      const s3Key = `videos/raw/${fileId}${extension}`;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: s3Key,
          Body: buffer,
          ContentType: mimeType,
          ServerSideEncryption: 'AES256',
          Metadata: {
            'original-name': encodeURIComponent(originalName),
            'lesson-id': lessonId,
            'uploaded-by': userId,
          },
        }),
      );

      const video = await this.prisma.video.create({
        data: {
          id: fileId,
          lessonId,
          originalFilename: originalName,
          filename: s3Key,
          size: BigInt(size),
          s3Key,
          originalUrl: this.buildUrl(s3Key),
          status: VideoStatus.UPLOADED,
        },
      });

      try {
        await this.videoQueue.add(
          'process-video',
          { videoId: fileId, s3Key, originalName, lessonId },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 10,
            removeOnFail: 5,
          },
        );
      } catch (queueErr: any) {
        // Redis unavailable in dev — job will be enqueued once Redis comes up
        this.logger.warn(`Queue unavailable, job not enqueued: ${queueErr.message}`);
      }

      this.logger.log(`Video uploaded: ${fileId}`);
      return { videoId: fileId, status: VideoStatus.UPLOADED, message: 'Video uploaded and queued for processing' };
    } catch (error: any) {
      this.logger.error(`Upload failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to upload video: ${error.message}`);
    }
  }

  async processVideo(videoId: string, transcodingOptions: TranscodingOptions[]) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });

    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.UPLOADED) {
      throw new BadRequestException('Video is not in UPLOADED state');
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.PROCESSING, processingStartedAt: new Date() },
    });

    const jobs = transcodingOptions.map((opt) =>
      this.videoQueue.add(
        'transcode-video',
        {
          videoId,
          s3Key: video.s3Key,
          quality: opt.quality,
          format: opt.format,
          generateThumbnail: opt.generateThumbnail,
        },
        { attempts: 2, backoff: { type: 'exponential', delay: 10000 } },
      ),
    );

    await Promise.all(jobs);
    return { videoId, status: VideoStatus.PROCESSING, message: 'Transcoding jobs queued' };
  }

  async transcodeVideo(
    videoId: string,
    s3Key: string,
    quality: string,
    format: 'mp4' | 'hls',
    generateThumbnail = true,
  ) {
    const profile = QUALITY_PROFILES[quality];
    if (!profile) throw new BadRequestException(`Unknown quality: ${quality}`);

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ev-${videoId}-`));

    try {
      // 1. Download source from S3 to temp file
      const srcPath = path.join(tmpDir, `source${path.extname(s3Key) || '.mp4'}`);
      await this.downloadFromS3(s3Key, srcPath);

      // 2. Extract video metadata (duration)
      const metadata = await this.getVideoMetadata(srcPath);

      // 3. Transcode
      let outputS3Key: string;
      if (format === 'hls') {
        outputS3Key = await this.transcodeToHLS(videoId, quality, profile, srcPath, tmpDir);
      } else {
        outputS3Key = await this.transcodeToMp4(videoId, quality, profile, srcPath, tmpDir);
      }

      // 4. Generate thumbnail
      let thumbnailUrl: string | undefined;
      if (generateThumbnail) {
        thumbnailUrl = await this.extractThumbnail(videoId, srcPath, tmpDir);
        if (thumbnailUrl) {
          await this.prisma.video.update({
            where: { id: videoId },
            data: { thumbnailUrl },
          });
        }
      }

      // 5. Get output file size
      let outputSize = BigInt(0);
      if (format === 'mp4') {
        const outPath = path.join(tmpDir, `${quality}.mp4`);
        try {
          const stat = await fs.promises.stat(outPath);
          outputSize = BigInt(stat.size);
        } catch {}
      }

      // 6. Persist variant
      const variant = await this.prisma.videoVariant.create({
        data: {
          videoId,
          quality,
          s3Key: outputS3Key,
          s3Url: this.buildUrl(outputS3Key),
          fileSize: outputSize,
          bitrate: parseInt(profile.videoBitrate),
          resolution: profile.resolution,
          duration: metadata.duration,
        },
      });

      // 7. Update video duration and check completion
      if (metadata.duration) {
        await this.prisma.video.update({
          where: { id: videoId },
          data: { duration: Math.round(metadata.duration) },
        });
      }

      await this.checkAndFinalizeVideo(videoId);

      return variant;
    } finally {
      // Always clean up temp files
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async getVideoStatus(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: { orderBy: { createdAt: 'desc' } },
        lesson: {
          select: {
            title: true,
            section: { select: { title: true, courseId: true } },
          },
        },
      },
    });

    if (!video) throw new NotFoundException('Video not found');

    return {
      id: video.id,
      status: video.status,
      originalFilename: video.originalFilename,
      fileSize: video.size?.toString(),
      duration: video.duration,
      thumbnailUrl: video.thumbnailUrl,
      processingProgress: this.calculateProgress(video.status, video.variants.length),
      uploadedAt: video.createdAt,
      processingStartedAt: video.processingStartedAt,
      processingCompletedAt: video.processingCompletedAt,
      errorMessage: video.errorMessage,
      variants: video.variants.map((v) => ({
        quality: v.quality,
        url: v.s3Url,
        fileSize: v.fileSize?.toString(),
        bitrate: v.bitrate,
        resolution: v.resolution,
        duration: v.duration,
        format: v.s3Key.endsWith('.m3u8') ? 'hls' : 'mp4',
      })),
      lesson: video.lesson ?? null,
    };
  }

  async generateSignedUrl(videoId: string, quality = '720p') {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { variants: { where: { quality } } },
    });

    if (!video) throw new NotFoundException('Video not found');
    if (video.status === VideoStatus.PENDING_REVIEW) {
      throw new BadRequestException('Video is pending admin approval and is not yet available for streaming');
    }
    if (video.status !== VideoStatus.READY) {
      throw new BadRequestException('Video is not ready for streaming');
    }

    let targetS3Key = video.variants[0]?.s3Key;

    if (!targetS3Key) {
      const fallback = await this.prisma.videoVariant.findFirst({
        where: { videoId },
        orderBy: { createdAt: 'desc' },
      });
      if (!fallback) throw new NotFoundException('No processed variants found');
      targetS3Key = fallback.s3Key;
    }

    // For CloudFront-backed assets, return direct URL (no signing needed)
    if (this.cloudFrontDomain) {
      return {
        streamUrl: this.buildUrl(targetS3Key),
        expiresIn: 3600,
        format: targetS3Key.endsWith('.m3u8') ? 'hls' : 'mp4',
      };
    }

    const signedUrl = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: targetS3Key }),
      { expiresIn: 3600 },
    );

    return {
      streamUrl: signedUrl,
      expiresIn: 3600,
      format: targetS3Key.endsWith('.m3u8') ? 'hls' : 'mp4',
    };
  }

  async getHLSManifest(videoId: string, quality = '720p'): Promise<string> {
    const variant = await this.prisma.videoVariant.findFirst({
      where: { videoId, quality, s3Key: { endsWith: '.m3u8' } },
    });

    if (!variant) throw new NotFoundException('HLS manifest not found for this quality');

    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: variant.s3Key }),
    );

    const body = resp.Body as any;
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
  }

  async deleteVideo(videoId: string, userId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: true,
        lesson: { include: { section: { include: { course: { select: { instructorId: true } } } } } },
      },
    });

    if (!video) throw new NotFoundException('Video not found');

    if (video.lesson?.section?.course?.instructorId !== userId) {
      throw new BadRequestException('Not authorized to delete this video');
    }

    const keysToDelete = [
      { Key: video.s3Key },
      ...video.variants.map((v: any) => ({ Key: v.s3Key })),
    ];

    if (keysToDelete.length > 0) {
      await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keysToDelete },
        }),
      );
    }

    await this.prisma.video.delete({ where: { id: videoId } });
    return { success: true, message: 'Video deleted' };
  }

  async getProcessingStats() {
    const [total, processing, failed, ready] = await Promise.all([
      this.prisma.video.count(),
      this.prisma.video.count({ where: { status: VideoStatus.PROCESSING } }),
      this.prisma.video.count({ where: { status: VideoStatus.FAILED } }),
      this.prisma.video.count({ where: { status: VideoStatus.READY } }),
    ]);
    return { total, processing, failed, ready, successRate: total > 0 ? (ready / total) * 100 : 0 };
  }

  async retryFailedVideo(videoId: string) {
    const video = await this.prisma.video.findUnique({ where: { id: videoId } });
    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.FAILED) {
      throw new BadRequestException('Video is not in FAILED state');
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.UPLOADED, errorMessage: null, processingStartedAt: null, processingCompletedAt: null },
    });

    await this.videoQueue.add('process-video', {
      videoId,
      s3Key: video.s3Key,
      originalName: video.originalFilename,
      lessonId: video.lessonId,
    });

    return { success: true, message: 'Video requeued for processing' };
  }

  async markVideoFailed(videoId: string, errorMessage: string) {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.FAILED, errorMessage },
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private async downloadFromS3(s3Key: string, destPath: string): Promise<void> {
    const resp = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
    );
    const body = resp.Body as any;
    const writeStream = fs.createWriteStream(destPath);
    await new Promise<void>((resolve, reject) => {
      body.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  }

  private async transcodeToMp4(
    videoId: string,
    quality: string,
    profile: QualityProfile,
    srcPath: string,
    tmpDir: string,
  ): Promise<string> {
    const outFile = path.join(tmpDir, `${quality}.mp4`);
    const s3Key = `videos/processed/${videoId}/${quality}.mp4`;

    await new Promise<void>((resolve, reject) => {
      ffmpeg(srcPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(profile.resolution)
        .videoBitrate(profile.videoBitrate)
        .audioBitrate(profile.audioBitrate)
        .outputOptions([
          '-preset fast',
          '-crf 23',
          '-movflags +faststart', // Web-optimized: moov atom at front
          '-pix_fmt yuv420p',
        ])
        .output(outFile)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });

    await this.uploadFileToS3(outFile, s3Key, 'video/mp4');
    return s3Key;
  }

  private async transcodeToHLS(
    videoId: string,
    quality: string,
    profile: QualityProfile,
    srcPath: string,
    tmpDir: string,
  ): Promise<string> {
    const hlsDir = path.join(tmpDir, `hls_${quality}`);
    await fs.promises.mkdir(hlsDir, { recursive: true });

    const playlistPath = path.join(hlsDir, 'index.m3u8');
    const segmentPattern = path.join(hlsDir, 'segment%03d.ts');

    await new Promise<void>((resolve, reject) => {
      ffmpeg(srcPath)
        .videoCodec('libx264')
        .audioCodec('aac')
        .size(profile.resolution)
        .videoBitrate(profile.videoBitrate)
        .audioBitrate(profile.audioBitrate)
        .outputOptions([
          '-preset fast',
          '-crf 23',
          '-pix_fmt yuv420p',
          '-hls_time 6',              // 6-second segments
          '-hls_list_size 0',         // Keep all segments in playlist
          '-hls_segment_type mpegts',
          `-hls_segment_filename ${segmentPattern}`,
          '-f hls',
        ])
        .output(playlistPath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });

    // Upload all HLS files to S3
    const hlsFiles = await fs.promises.readdir(hlsDir);
    const s3Prefix = `videos/hls/${videoId}/${quality}`;

    await Promise.all(
      hlsFiles.map(async (file) => {
        const filePath = path.join(hlsDir, file);
        const contentType = file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/MP2T';
        await this.uploadFileToS3(filePath, `${s3Prefix}/${file}`, contentType);
      }),
    );

    return `${s3Prefix}/index.m3u8`;
  }

  private async extractThumbnail(
    videoId: string,
    srcPath: string,
    tmpDir: string,
  ): Promise<string | undefined> {
    const thumbFile = path.join(tmpDir, 'thumbnail.jpg');

    try {
      await new Promise<void>((resolve, reject) => {
        ffmpeg(srcPath)
          .screenshots({
            timestamps: ['10%'],
            filename: 'thumbnail.jpg',
            folder: tmpDir,
            size: '1280x720',
          })
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err));
      });

      const s3Key = `videos/thumbnails/${videoId}/thumbnail.jpg`;
      await this.uploadFileToS3(thumbFile, s3Key, 'image/jpeg');
      return this.buildUrl(s3Key);
    } catch (err: any) {
      this.logger.warn(`Thumbnail generation failed: ${err.message}`);
      return undefined;
    }
  }

  private async uploadFileToS3(filePath: string, s3Key: string, contentType: string): Promise<void> {
    const fileBuffer = await fs.promises.readFile(filePath);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: fileBuffer,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  private async getVideoMetadata(filePath: string): Promise<{ duration?: number }> {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          this.logger.warn(`Could not probe video metadata: ${err.message}`);
          resolve({});
        } else {
          resolve({ duration: metadata.format.duration });
        }
      });
    });
  }

  private async checkAndFinalizeVideo(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        variants: true,
        lesson: {
          select: {
            title: true,
            section: { select: { course: { select: { title: true } } } },
          },
        },
      },
    });
    if (!video) return;

    const expectedQualities = ['360p', '480p', '720p'];
    const done = expectedQualities.every((q) => video.variants.some((v: any) => v.quality === q));

    if (done) {
      const best =
        video.variants.find((v: any) => v.quality === '720p') ||
        video.variants.find((v: any) => v.quality === '480p') ||
        video.variants[0];

      // Move to PENDING_REVIEW — superadmin must approve before students can stream
      await this.prisma.video.update({
        where: { id: videoId },
        data: { status: VideoStatus.PENDING_REVIEW, processingCompletedAt: new Date(), processedUrl: best?.s3Url },
      });

      // Notify all superadmins that a new video is awaiting review
      try {
        const superAdmins = await this.prisma.user.findMany({
          where: { role: 'SUPER_ADMIN', isActive: true },
          select: { id: true },
        });
        if (superAdmins.length > 0) {
          const lessonTitle = video.lesson?.title ?? 'Unknown lesson';
          const courseTitle = (video.lesson as any)?.section?.course?.title ?? 'Unknown course';
          await this.prisma.notification.createMany({
            data: superAdmins.map((u) => ({
              userId: u.id,
              title: 'New video awaiting review',
              message: `"${lessonTitle}" in "${courseTitle}" has been transcoded and is pending your approval.`,
              type: 'SYSTEM_ALERT' as any,
              actionUrl: `/admin/videos/pending`,
            })),
          });
        }
      } catch (err: any) {
        this.logger.warn(`Failed to notify superadmins of pending video: ${err.message}`);
      }
    }
  }

  async deleteVideoAdmin(videoId: string): Promise<void> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { variants: true },
    });
    if (!video) throw new NotFoundException('Video not found');

    const keysToDelete = [
      { Key: video.s3Key },
      ...video.variants.map((v: any) => ({ Key: v.s3Key })),
    ];

    if (keysToDelete.length > 0) {
      try {
        await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keysToDelete },
          }),
        );
      } catch (err: any) {
        this.logger.warn(`S3 delete partially failed for video ${videoId}: ${err.message}`);
      }
    }

    await this.prisma.video.delete({ where: { id: videoId } });
  }

  private calculateProgress(status: VideoStatus, variantCount: number): number {
    switch (status) {
      case VideoStatus.UPLOADED:        return 10;
      case VideoStatus.PROCESSING:      return 10 + Math.min(variantCount * 25, 80);
      case VideoStatus.PENDING_REVIEW:  return 100;
      case VideoStatus.READY:           return 100;
      case VideoStatus.FAILED:          return 0;
      default:                          return 0;
    }
  }

  private buildUrl(s3Key: string): string {
    if (this.cloudFrontDomain) {
      return `https://${this.cloudFrontDomain}/${s3Key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;
  }
}
