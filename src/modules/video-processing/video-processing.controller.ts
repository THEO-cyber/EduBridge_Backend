import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Body,
  Query,
  BadRequestException,
  Header,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
  ApiQuery,
} from '@nestjs/swagger';
import { Response } from 'express';
import { VideoProcessingService } from './video-processing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, User } from '@prisma/client';
import {
  IsString,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsArray,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Known video magic bytes: [offset, bytes]
const VIDEO_SIGNATURES: Array<[number, number[]]> = [
  [0,  [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]], // MP4 ftyp
  [0,  [0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]], // MP4 ftyp variant
  [4,  [0x66, 0x74, 0x79, 0x70]],                          // MP4/MOV ftyp at offset 4
  [0,  [0x1A, 0x45, 0xDF, 0xA3]],                          // MKV/WebM EBML
  [0,  [0x52, 0x49, 0x46, 0x46]],                          // AVI RIFF
  [0,  [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]], // WMV ASF
  [0,  [0x00, 0x00, 0x01, 0xBA]],                          // MPEG-PS
  [0,  [0x00, 0x00, 0x01, 0xB3]],                          // MPEG video
  [0,  [0x66, 0x4C, 0x61, 0x43]],                          // FLV (flac — keep out)
  [0,  [0x46, 0x4C, 0x56]],                                // FLV header
];

function validateVideoMagicBytes(buffer: Buffer, filename: string): void {
  if (!buffer || buffer.length < 12) {
    throw new BadRequestException('File is too small to be a valid video');
  }
  const matched = VIDEO_SIGNATURES.some(([offset, sig]) =>
    sig.every((byte, i) => buffer[offset + i] === byte),
  );
  if (!matched) {
    throw new BadRequestException(
      `File "${filename}" does not appear to be a valid video (magic byte mismatch)`,
    );
  }
}

class InitiateProcessingDto {
  @IsString()
  videoId!: string;

  @IsOptional()
  @IsArray()
  qualities?: Array<'360p' | '480p' | '720p' | '1080p'>;

  @IsOptional()
  @IsEnum(['mp4', 'hls'])
  format?: 'mp4' | 'hls';

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  generateThumbnail?: boolean;
}

const DEFAULT_TRANSCODE_OPTIONS = [
  { quality: '360p'  as const, format: 'mp4' as const, generateThumbnail: true  },
  { quality: '480p'  as const, format: 'mp4' as const, generateThumbnail: false },
  { quality: '720p'  as const, format: 'mp4' as const, generateThumbnail: false },
];

@ApiTags('Video Processing')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('video-processing')
export class VideoProcessingController {
  constructor(private readonly videoProcessingService: VideoProcessingService) {}

  // ── Upload ──────────────────────────────────────────────────────────────────

  @Post('upload/:lessonId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Upload a video for a lesson (instructor only)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { video: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('video', {
      limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2 GB
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('video/')) {
          return cb(new BadRequestException('Only video files are allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadVideo(
    @Param('lessonId') lessonId: string,
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
  ) {
    if (!file) throw new BadRequestException('No video file provided');

    // Magic byte validation — client-supplied MIME is not trusted
    validateVideoMagicBytes(file.buffer, file.originalname);

    return this.videoProcessingService.uploadVideo({
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      lessonId,
      userId: user.id,
    });
  }

  // ── Fast upload (presigned URL) ──────────────────────────────────────────────

  @Post('initiate-upload/:lessonId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({
    summary: 'Get a presigned PUT URL — client uploads directly to MinIO/S3 (no NestJS buffer)',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['filename', 'mimeType', 'fileSize'],
      properties: {
        filename: { type: 'string' },
        mimeType: { type: 'string' },
        fileSize: { type: 'number' },
      },
    },
  })
  async initiateUpload(
    @Param('lessonId') lessonId: string,
    @Body('filename') filename: string,
    @Body('mimeType') mimeType: string,
    @Body('fileSize') fileSize: number,
    @CurrentUser() user: User,
  ) {
    if (!filename || !mimeType || !fileSize) {
      throw new BadRequestException('filename, mimeType and fileSize are required');
    }
    return this.videoProcessingService.initiateUpload(lessonId, user.id, filename, mimeType, fileSize);
  }

  @Post('complete-upload/:videoId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm direct upload finished and start transcoding' })
  async completeUpload(
    @Param('videoId') videoId: string,
    @CurrentUser() user: User,
  ) {
    return this.videoProcessingService.completeUpload(videoId, user.id);
  }

  // ── Process ─────────────────────────────────────────────────────────────────

  @Post('process')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Initiate transcoding for an uploaded video (instructor only)' })
  async initiateProcessing(
    @Body() dto: InitiateProcessingDto,
    @CurrentUser() _user: User,
  ) {
    const options = dto.qualities
      ? dto.qualities.map((q) => ({
          quality: q,
          format: dto.format ?? ('mp4' as const),
          generateThumbnail: q === '720p' && dto.generateThumbnail !== false,
        }))
      : DEFAULT_TRANSCODE_OPTIONS;

    return this.videoProcessingService.processVideo(dto.videoId, options);
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  @Get('status/:videoId')
  @ApiOperation({ summary: 'Get video processing status and available variants' })
  async getVideoStatus(@Param('videoId') videoId: string) {
    return this.videoProcessingService.getVideoStatus(videoId);
  }

  // ── Streaming ───────────────────────────────────────────────────────────────

  @Get('stream-url/:videoId')
  @ApiOperation({ summary: 'Get a short-lived pre-signed URL for direct video playback' })
  @ApiQuery({ name: 'quality', required: false, enum: ['360p', '480p', '720p', '1080p'] })
  async getStreamUrl(
    @Param('videoId') videoId: string,
    @Query('quality') quality = '720p',
  ) {
    return this.videoProcessingService.generateSignedUrl(videoId, quality);
  }

  @Get('stream/:videoId')
  @ApiOperation({
    summary: 'Redirect to a short-lived presigned URL — client streams directly from MinIO/S3/CDN',
  })
  @ApiQuery({ name: 'quality', required: false, enum: ['360p', '480p', '720p', '1080p'] })
  async streamVideo(
    @Param('videoId') videoId: string,
    @Query('quality') quality = '720p',
    @Res() res: Response,
  ) {
    // Auth is checked by JwtAuthGuard at class level.
    // NestJS only handles this one small request — actual video bytes never touch this process.
    const { streamUrl } = await this.videoProcessingService.generateSignedUrl(videoId, quality);
    (res as any).redirect(302, streamUrl);
  }

  @Get('hls/:videoId/manifest')
  @ApiOperation({ summary: 'Get the HLS .m3u8 manifest for adaptive streaming' })
  @ApiQuery({ name: 'quality', required: false, enum: ['360p', '480p', '720p', '1080p'] })
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', 'no-cache')
  async getHLSManifest(
    @Param('videoId') videoId: string,
    @Query('quality') quality = '720p',
    @Res() res: Response,
  ) {
    const manifest = await this.videoProcessingService.getHLSManifest(videoId, quality);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(manifest);
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  @Delete(':videoId')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Delete a video and all its S3 variants (instructor only)' })
  async deleteVideo(
    @Param('videoId') videoId: string,
    @CurrentUser() user: User,
  ) {
    return this.videoProcessingService.deleteVideo(videoId, user.id);
  }

  // ── Admin ───────────────────────────────────────────────────────────────────

  @Get('admin/stats')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Video processing statistics (admin only)' })
  async getProcessingStats() {
    return this.videoProcessingService.getProcessingStats();
  }

  @Post('admin/retry/:videoId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Retry a failed video (admin only)' })
  async retryFailedVideo(@Param('videoId') videoId: string) {
    return this.videoProcessingService.retryFailedVideo(videoId);
  }
}
