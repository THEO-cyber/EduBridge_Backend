
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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { VideoProcessingService } from './video-processing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, User } from '@prisma/client';
import { IsString, IsEnum, IsOptional, IsBoolean } from 'class-validator';

class InitiateProcessingDto {
  @IsString()
  videoId!: string;

  @IsOptional()
  qualities?: Array<'360p' | '480p' | '720p' | '1080p'>;

  @IsOptional()
  @IsEnum(['mp4', 'hls'])
  format?: 'mp4' | 'hls';

  @IsOptional()
  @IsBoolean()
  generateThumbnail?: boolean;
}

@ApiTags('Video Processing')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('video-processing')
export class VideoProcessingController {
  constructor(
    private readonly videoProcessingService: VideoProcessingService,
  ) {}

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post('upload/:lessonId')
  @ApiOperation({ summary: 'Upload video for lesson (Instructor only)' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        video: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('video', {
      limits: {
        fileSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
      fileFilter: (req, file, callback) => {
        if (!file.mimetype.startsWith('video/')) {
          return callback(new Error('Only video files are allowed'), false);
        }
        callback(null, true);
      },
    }),
  )
  async uploadVideo(
    @Param('lessonId') lessonId: string,
    @UploadedFile() file: any,
    @CurrentUser() user: User,
  ) {
    if (!file) {
      throw new Error('No video file provided');
    }

    return this.videoProcessingService.uploadVideo({
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
      lessonId,
      userId: user.id,
    });
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Post('process')
  @ApiOperation({ summary: 'Initiate video processing (Instructor only)' })
  async initiateProcessing(
    @Body() dto: InitiateProcessingDto,
    @CurrentUser() user: User,
  ) {
    const defaultOptions = [
      {
        quality: '360p' as const,
        format: 'mp4' as const,
        generateThumbnail: true,
      },
      {
        quality: '480p' as const,
        format: 'mp4' as const,
        generateThumbnail: false,
      },
      {
        quality: '720p' as const,
        format: 'mp4' as const,
        generateThumbnail: false,
      },
    ];

    const transcodingOptions = dto.qualities
      ? dto.qualities.map((quality) => ({
          quality,
          format: dto.format || 'mp4',
          generateThumbnail:
            quality === '720p' && dto.generateThumbnail !== false,
        }))
      : defaultOptions;

    return this.videoProcessingService.processVideo(
      dto.videoId,
      transcodingOptions,
    );
  }

  @Get('status/:videoId')
  @ApiOperation({ summary: 'Get video processing status' })
  async getVideoStatus(@Param('videoId') videoId: string) {
    return this.videoProcessingService.getVideoStatus(videoId);
  }

  @Get('stream/:videoId')
  @ApiOperation({ summary: 'Get signed URL for video streaming' })
  async getStreamingUrl(
    @Param('videoId') videoId: string,
    @Query('quality') quality?: string,
  ) {
    const signedUrl = await this.videoProcessingService.generateSignedUrl(
      videoId,
      quality || '720p',
    );

    return {
      streamUrl: signedUrl,
      expiresIn: 3600, // 1 hour
    };
  }

  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @Delete(':videoId')
  @ApiOperation({ summary: 'Delete video and all variants (Instructor only)' })
  async deleteVideo(
    @Param('videoId') videoId: string,
    @CurrentUser() user: User,
  ) {
    return this.videoProcessingService.deleteVideo(videoId, user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Get('admin/stats')
  @ApiOperation({ summary: 'Get video processing statistics (Admin only)' })
  async getProcessingStats() {
    return this.videoProcessingService.getProcessingStats();
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Post('admin/retry/:videoId')
  @ApiOperation({ summary: 'Retry failed video processing (Admin only)' })
  async retryFailedVideo(@Param('videoId') videoId: string) {
    return this.videoProcessingService.retryFailedVideo(videoId);
  }
}
