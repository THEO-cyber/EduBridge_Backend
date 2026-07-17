import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
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
  private s3Public: S3Client; // same creds, but uses the public-facing MinIO URL for presigned PUTs
  private readonly bucket: string;
  private readonly region: string;
  private readonly cloudFrontDomain?: string;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private readonly jwt: JwtService,
    @InjectQueue('video-processing') private videoQueue: any,
  ) {
    this.region = this.configService.get<string>('aws.region') || 'us-east-1';
    this.bucket = this.configService.get<string>('aws.s3Bucket') || '';
    this.cloudFrontDomain = this.configService.get<string>('AWS_CLOUDFRONT_DOMAIN');

    const s3Endpoint   = this.configService.get<string>('S3_ENDPOINT');
    // MINIO_PUBLIC_URL: the URL clients (Flutter) use to reach MinIO directly.
    // Defaults to S3_ENDPOINT when not set (works fine on the same machine).
    const s3PublicUrl  = this.configService.get<string>('MINIO_PUBLIC_URL') || s3Endpoint;

    const credentials = {
      accessKeyId:     this.configService.get<string>('aws.accessKeyId') || '',
      secretAccessKey: this.configService.get<string>('aws.secretAccessKey') || '',
    };

    this.s3 = new S3Client({
      region: this.region,
      credentials,
      ...(s3Endpoint ? { endpoint: s3Endpoint, forcePathStyle: true } : {}),
    });

    // Used only for generating presigned PUT URLs returned to mobile clients
    this.s3Public = new S3Client({
      region: this.region,
      credentials,
      ...(s3PublicUrl ? { endpoint: s3PublicUrl, forcePathStyle: true } : {}),
    });

    // Guard against the classic R2 misconfiguration: a non-AWS region (e.g.
    // "auto") with no S3_ENDPOINT makes the SDK build the invalid host
    // <bucket>.s3.<region>.amazonaws.com → getaddrinfo ENOTFOUND on every op.
    if (!s3Endpoint && !/^(us|eu|ap|sa|ca|af|me)-/.test(this.region)) {
      this.logger.error(
        `Storage misconfigured: AWS_REGION="${this.region}" but S3_ENDPOINT is not set. ` +
          `For Cloudflare R2 set S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com ` +
          `(with AWS_REGION=auto). Uploads/streaming will fail until this is fixed.`,
      );
    }
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

      if (process.env.REDIS_AVAILABLE === 'true') {
        try {
          await this.videoQueue.add(
            'process-video',
            { videoId: fileId, s3Key, originalName, lessonId },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: 10,
              removeOnFail: 5,
              priority: 1, // orchestration jobs always jump ahead of transcode jobs
            },
          );
        } catch (queueErr: any) {
          this.logger.warn(`Queue add failed, falling back to direct processing: ${queueErr.message}`);
          this.processVideoDirectly(fileId, s3Key);
        }
      } else {
        // No Redis — bypass BullMQ and transcode directly in-process
        this.processVideoDirectly(fileId, s3Key);
      }

      this.logger.log(`Video uploaded: ${fileId}`);
      return { videoId: fileId, status: VideoStatus.UPLOADED, message: 'Video uploaded and queued for processing' };
    } catch (error: any) {
      this.logger.error(`Upload failed: ${error.message}`, error.stack);
      throw new BadRequestException(`Failed to upload video: ${error.message}`);
    }
  }

  /**
   * Step 1 of the fast-upload flow.
   * Returns a presigned PUT URL pointing at the public MinIO address so the
   * client can upload the file directly — NestJS never buffers the bytes.
   */
  async initiateUpload(
    lessonId: string,
    userId: string,
    filename: string,
    mimeType: string,
    fileSize: number,
  ) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      include: { section: { include: { course: { select: { instructorId: true } } } } },
    });
    if (!lesson) throw new NotFoundException('Lesson not found');
    if (lesson.section.course.instructorId !== userId) {
      throw new BadRequestException('Not authorized to upload video for this lesson');
    }

    const fileId   = crypto.randomUUID();
    const ext      = path.extname(filename).toLowerCase() || '.mp4';
    const s3Key    = `videos/raw/${fileId}${ext}`;

    await this.prisma.video.create({
      data: {
        id: fileId,
        lessonId,
        originalFilename: filename,
        filename: s3Key,
        size: BigInt(fileSize),
        s3Key,
        originalUrl: this.buildUrl(s3Key),
        status: VideoStatus.UPLOADED,
      },
    });

    // Presigned PUT — client uploads directly to MinIO (or S3 in production)
    const uploadUrl = await getSignedUrl(
      this.s3Public,
      new PutObjectCommand({
        Bucket:      this.bucket,
        Key:         s3Key,
        ContentType: mimeType,
      }),
      { expiresIn: 3600 },
    );

    return { videoId: fileId, uploadUrl, s3Key, expiresIn: 3600 };
  }

  /**
   * Step 2 of the fast-upload flow.
   * Called after the client has finished the direct PUT to MinIO.
   * Queues the transcoding job and returns the video record.
   */
  async completeUpload(videoId: string, userId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: {
        lesson: {
          include: { section: { include: { course: { select: { instructorId: true } } } } },
        },
      },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (video.lesson?.section?.course?.instructorId !== userId) {
      throw new BadRequestException('Not authorized');
    }
    if (video.status !== VideoStatus.UPLOADED) {
      throw new BadRequestException('Video is not in UPLOADED state');
    }

    // Direct-play mode (VIDEO_DIRECT_PLAY=true): skip ffmpeg transcoding and
    // serve the original upload as-is. Ideal for low-resource hosts (e.g. free
    // tiers) since transcoding is CPU/RAM heavy. Flutter's player streams MP4.
    if (process.env.VIDEO_DIRECT_PLAY === 'true') {
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.READY,
          processedUrl: video.originalUrl,
          processingCompletedAt: new Date(),
        },
      });
      return { videoId, status: VideoStatus.READY, message: 'Upload confirmed — ready to stream' };
    }

    if (process.env.REDIS_AVAILABLE === 'true') {
      try {
        await this.videoQueue.add(
          'process-video',
          { videoId, s3Key: video.s3Key, originalName: video.originalFilename, lessonId: video.lessonId },
          { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 10, removeOnFail: 5, priority: 1 },
        );
      } catch (queueErr: any) {
        this.logger.warn(`Queue add failed, falling back to direct processing: ${queueErr.message}`);
        this.processVideoDirectly(videoId, video.s3Key);
      }
    } else {
      this.processVideoDirectly(videoId, video.s3Key);
    }

    return { videoId, status: VideoStatus.UPLOADED, message: 'Upload confirmed — transcoding started' };
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

    // Smaller files get lower priority number = processed sooner.
    // 100 MB threshold: short clips (tutorials, demos) jump ahead of hour-long lectures.
    const fileSizeBytes = video.size ? Number(video.size) : 0;
    const transcodePriority = fileSizeBytes < 100 * 1024 * 1024 ? 5 : 20;

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
        { attempts: 2, backoff: { type: 'exponential', delay: 10000 }, priority: transcodePriority },
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
      // Fall back to the original upload when there are no transcoded variants
      // (direct-play mode) so the video still streams.
      targetS3Key = fallback?.s3Key ?? video.s3Key;
    }
    if (!targetS3Key) throw new NotFoundException('No video file found');

    const format = targetS3Key.endsWith('.m3u8') ? 'hls' : 'mp4';

    // 1. NGINX CDN (Docker production) — stable cacheable URL, no expiry
    const cdnBase = this.configService.get<string>('MEDIA_CDN_URL');
    if (cdnBase) {
      return { streamUrl: `${cdnBase}/media/${targetS3Key}`, expiresIn: 0, format };
    }

    // 2. CloudFront (AWS production)
    if (this.cloudFrontDomain) {
      return { streamUrl: this.buildUrl(targetS3Key), expiresIn: 3600, format };
    }

    // 3. Presigned URL (local dev without NGINX)
    const signedUrl = await getSignedUrl(
      this.s3Public,
      new GetObjectCommand({ Bucket: this.bucket, Key: targetS3Key }),
      { expiresIn: 3600 },
    );
    return { streamUrl: signedUrl, expiresIn: 3600, format };
  }

  // Admin-only: generates a preview URL without checking video status
  async adminPreviewUrl(videoId: string, quality = '720p') {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { variants: { where: { quality } } },
    });
    if (!video) throw new NotFoundException('Video not found');

    let targetS3Key = video.variants[0]?.s3Key;
    if (!targetS3Key) {
      const fallback = await this.prisma.videoVariant.findFirst({
        where: { videoId },
        orderBy: { createdAt: 'desc' },
      });
      if (!fallback) throw new NotFoundException('No processed variants found for this video');
      targetS3Key = fallback.s3Key;
    }

    const format = targetS3Key.endsWith('.m3u8') ? 'hls' : 'mp4';
    const cdnBase = this.configService.get<string>('MEDIA_CDN_URL');
    if (cdnBase) {
      return { streamUrl: `${cdnBase}/media/${targetS3Key}`, expiresIn: 0, format };
    }
    if (this.cloudFrontDomain) {
      return { streamUrl: this.buildUrl(targetS3Key), expiresIn: 3600, format };
    }
    const signedUrl = await getSignedUrl(
      this.s3Public,
      new GetObjectCommand({ Bucket: this.bucket, Key: targetS3Key }),
      { expiresIn: 3600 },
    );
    return { streamUrl: signedUrl, expiresIn: 3600, format };
  }

  async streamVideoChunk(videoId: string, quality = '720p', rangeHeader?: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { variants: { where: { quality } } },
    });

    if (!video) throw new NotFoundException('Video not found');
    if (video.status === VideoStatus.PENDING_REVIEW)
      throw new BadRequestException('Video is pending admin approval');
    if (video.status !== VideoStatus.READY)
      throw new BadRequestException('Video is not ready for streaming');

    // Resolve variant — fall back to any available quality
    let variant: any = video.variants[0];
    if (!variant) {
      variant = await this.prisma.videoVariant.findFirst({
        where: { videoId, s3Key: { endsWith: '.mp4' } },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!variant) throw new NotFoundException('No processed variant found');

    const totalSize = Number(variant.fileSize);
    if (!totalSize) throw new BadRequestException('Video file size unknown — cannot stream');

    // Parse Range header: "bytes=start-end"
    const CHUNK = 10 * 1024 * 1024; // 10 MB per chunk
    let start = 0;
    let end = Math.min(CHUNK - 1, totalSize - 1);

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        start = parseInt(m[1], 10);
        end   = m[2] ? parseInt(m[2], 10) : Math.min(start + CHUNK - 1, totalSize - 1);
        end   = Math.min(end, totalSize - 1);
      }
    }

    const contentLength = end - start + 1;

    const s3Response = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key:    variant.s3Key,
        Range:  `bytes=${start}-${end}`,
      }),
    );

    return {
      stream: s3Response.Body,
      start,
      end,
      totalSize,
      contentLength,
    };
  }

  async getHLSManifest(videoId: string, quality = '720p'): Promise<string> {
    const variant = await this.prisma.videoVariant.findFirst({
      where: { videoId, quality, s3Key: { endsWith: '.m3u8' } },
    });

    if (!variant) throw new NotFoundException('HLS manifest not found for this quality');
    return this.readS3Text(variant.s3Key);
  }

  private async readS3Text(key: string): Promise<string> {
    const resp = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of resp.Body as any) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf-8');
  }

  // ── Adaptive bitrate streaming ─────────────────────────────────────────────
  //
  // Native players (ExoPlayer / AVPlayer) fetch the playlists themselves, and we
  // cannot attach an Authorization header to those requests without it also being
  // sent to the presigned object URLs — where S3/R2 rejects a request carrying two
  // auth mechanisms. So playback is authorised by a short-lived token in the query
  // string, and the media segments are presigned URLs that need no auth at all.

  private readonly PLAYBACK_TTL = 6 * 3600; // 6h — long enough for any single lesson

  async createPlaybackToken(videoId: string, userId: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, vid: videoId, typ: 'playback' },
      { expiresIn: this.PLAYBACK_TTL },
    );
  }

  private async assertPlaybackToken(token: string, videoId: string): Promise<void> {
    if (!token) throw new UnauthorizedException('Playback token required');
    try {
      const payload: any = await this.jwt.verifyAsync(token);
      if (payload?.typ !== 'playback' || payload?.vid !== videoId) {
        throw new Error('token is not scoped to this video');
      }
    } catch {
      throw new UnauthorizedException('Invalid or expired playback token');
    }
  }

  /**
   * Tells the client how to play a video: an adaptive HLS master playlist when
   * renditions exist, otherwise a plain presigned MP4 (direct-play mode).
   */
  async getPlaybackInfo(videoId: string, userId: string, baseUrl: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { variants: true },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.READY) {
      throw new BadRequestException('Video is not ready for streaming');
    }

    const adaptive = video.variants.some((v: any) => v.s3Key.endsWith('.m3u8'));
    if (adaptive) {
      const token = await this.createPlaybackToken(videoId, userId);
      return {
        adaptive: true,
        hlsUrl: `${baseUrl}/video-processing/hls/${videoId}/master.m3u8?t=${encodeURIComponent(token)}`,
        renditions: video.variants
          .filter((v: any) => v.s3Key.endsWith('.m3u8'))
          .map((v: any) => v.quality),
      };
    }

    // No renditions (direct-play): fall back to a single presigned file.
    const { streamUrl } = await this.generateSignedUrl(videoId);
    return { adaptive: false, hlsUrl: null, mp4Url: streamUrl, renditions: [] };
  }

  /** Master playlist: lists every rendition so the player can switch on bandwidth. */
  async getMasterPlaylist(videoId: string, token: string, baseUrl: string): Promise<string> {
    await this.assertPlaybackToken(token, videoId);

    const variants = await this.prisma.videoVariant.findMany({
      where: { videoId, s3Key: { endsWith: '.m3u8' } },
    });
    if (!variants.length) {
      throw new NotFoundException('This video has no adaptive renditions');
    }

    const order = ['360p', '480p', '720p', '1080p'];
    const sorted = [...variants].sort(
      (a: any, b: any) => order.indexOf(a.quality) - order.indexOf(b.quality),
    );

    const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];
    for (const v of sorted as any[]) {
      const profile = QUALITY_PROFILES[v.quality];
      // BANDWIDTH must be bits/sec and include audio. Stored bitrate is kbps.
      const bandwidth = profile
        ? (parseInt(profile.videoBitrate) + parseInt(profile.audioBitrate)) * 1000
        : (v.bitrate || 1000) * 1000;
      const resolution = v.resolution || profile?.resolution || '640x360';
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="avc1.4d401f,mp4a.40.2"`,
      );
      lines.push(
        `${baseUrl}/video-processing/hls/${videoId}/${v.quality}/playlist.m3u8?t=${encodeURIComponent(token)}`,
      );
    }
    return lines.join('\n') + '\n';
  }

  /**
   * Rendition playlist. The stored playlist references segments by bare filename,
   * so each is rewritten to an absolute presigned URL — the player then pulls the
   * media straight from object storage and never touches this process again.
   */
  async getVariantPlaylist(videoId: string, quality: string, token: string): Promise<string> {
    await this.assertPlaybackToken(token, videoId);

    const variant = await this.prisma.videoVariant.findFirst({
      where: { videoId, quality, s3Key: { endsWith: '.m3u8' } },
    });
    if (!variant) throw new NotFoundException(`No ${quality} rendition for this video`);

    const raw = await this.readS3Text(variant.s3Key);
    const dir = variant.s3Key.slice(0, variant.s3Key.lastIndexOf('/'));

    const out = await Promise.all(
      raw.split('\n').map(async (line) => {
        const t = line.trim();
        if (!t || t.startsWith('#')) return line; // directive or blank — keep as-is
        return getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: this.bucket, Key: `${dir}/${t}` }),
          { expiresIn: this.PLAYBACK_TTL },
        );
      }),
    );
    return out.join('\n');
  }

  /**
   * A single downloadable file for offline study. Defaults to the smallest
   * rendition so a learner spends as little of their data bundle as possible.
   */
  async getDownloadUrl(videoId: string, quality?: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      include: { variants: true },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (video.status !== VideoStatus.READY) {
      throw new BadRequestException('Video is not ready for download');
    }

    // Offline playback needs one self-contained file, so HLS renditions are skipped.
    const files = video.variants.filter((v: any) => !v.s3Key.endsWith('.m3u8'));
    const order = ['360p', '480p', '720p', '1080p'];
    const sorted = [...files].sort(
      (a: any, b: any) => order.indexOf(a.quality) - order.indexOf(b.quality),
    );

    const chosen: any =
      (quality && sorted.find((v: any) => v.quality === quality)) || sorted[0] || null;
    const key = chosen?.s3Key ?? video.s3Key;
    if (!key) throw new NotFoundException('No downloadable file for this video');

    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: this.PLAYBACK_TTL },
    );

    return {
      url,
      quality: chosen?.quality ?? 'source',
      sizeBytes: Number(chosen?.fileSize ?? 0) || null,
      available: sorted.map((v: any) => ({
        quality: v.quality,
        sizeBytes: Number(v.fileSize ?? 0) || null,
      })),
      expiresIn: this.PLAYBACK_TTL,
    };
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
    if (video.status !== VideoStatus.FAILED && video.status !== VideoStatus.PROCESSING) {
      throw new BadRequestException('Video must be in FAILED or PROCESSING state to retry');
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.UPLOADED, errorMessage: null, processingStartedAt: null, processingCompletedAt: null },
    });

    if (process.env.REDIS_AVAILABLE === 'true') {
      await this.videoQueue.add('process-video', {
        videoId,
        s3Key: video.s3Key,
        originalName: video.originalFilename,
        lessonId: video.lessonId,
      });
    } else {
      this.processVideoDirectly(videoId, video.s3Key);
    }

    return { success: true, message: 'Video requeued for processing' };
  }

  async markVideoFailed(videoId: string, errorMessage: string) {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.FAILED, errorMessage },
    });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Runs transcoding directly in-process without BullMQ.
   * Used when Redis is unavailable (development without Redis installed).
   * Fires and forgets — caller gets the upload response immediately.
   */
  private processVideoDirectly(videoId: string, s3Key: string): void {
    const opts: TranscodingOptions[] = [
      { quality: '360p', format: 'mp4', generateThumbnail: true },
      { quality: '480p', format: 'mp4', generateThumbnail: false },
      { quality: '720p', format: 'mp4', generateThumbnail: false },
    ];

    (async () => {
      try {
        await this.prisma.video.update({
          where: { id: videoId },
          data: { status: VideoStatus.PROCESSING, processingStartedAt: new Date() },
        });
        // Run all quality variants in parallel — 3× faster than sequential
        await Promise.all(
          opts.map((opt) =>
            this.transcodeVideo(videoId, s3Key, opt.quality, opt.format, opt.generateThumbnail),
          ),
        );
        this.logger.log(`Direct transcoding completed for video ${videoId}`);
      } catch (error: any) {
        this.logger.error(`Direct transcoding failed for ${videoId}: ${error.message}`);
        await this.markVideoFailed(videoId, error.message).catch(() => {});
      }
    })();
  }

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

      // If the course is already published, go straight to READY (no separate video review needed)
      const publishedCourse = await this.prisma.course.findFirst({
        where: {
          isPublished: true,
          sections: { some: { lessons: { some: { videos: { some: { id: videoId } } } } } },
        },
      });

      if (publishedCourse) {
        await this.prisma.video.update({
          where: { id: videoId },
          data: { status: VideoStatus.READY, processingCompletedAt: new Date(), processedUrl: best?.s3Url },
        });
        if (best && video.lessonId) {
          await this.prisma.lesson.update({
            where: { id: video.lessonId },
            data: { videoUrl: best.s3Url, duration: video.duration },
          });
        }
        this.logger.log(`Video ${videoId} auto-approved — course already published`);
        return;
      }

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
    // Prefer an explicit public base (R2 public domain / CDN) or the S3-compatible
    // endpoint (Cloudflare R2, MinIO). Only fall back to the AWS virtual-host
    // pattern when nothing is configured — otherwise region "auto" (R2) would
    // produce the invalid host <bucket>.s3.auto.amazonaws.com.
    const publicBase =
      this.configService.get<string>('S3_PUBLIC_URL') ||
      this.configService.get<string>('MINIO_PUBLIC_URL') ||
      this.configService.get<string>('S3_ENDPOINT');
    if (publicBase) {
      return `${publicBase.replace(/\/+$/, '')}/${this.bucket}/${s3Key}`;
    }
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;
  }
}
