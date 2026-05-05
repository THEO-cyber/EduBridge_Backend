import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { EnrollmentsService } from './enrollments.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '@prisma/client';
import { IsNumber, IsBoolean, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

class UpdateProgressDto {
  @IsNumber()
  @Type(() => Number)
  watchTime: number;

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isCompleted?: boolean;
}

@ApiTags('Enrollments')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('enrollments')
export class EnrollmentsController {
  constructor(private readonly enrollmentsService: EnrollmentsService) {}

  @Get()
  @ApiOperation({ summary: 'Get user enrollments' })
  async getUserEnrollments(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.enrollmentsService.getUserEnrollments(user.id, paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get enrollment details' })
  async getEnrollmentDetails(
    @Param('id') id: string,
    @CurrentUser() user: User,
  ) {
    return this.enrollmentsService.getEnrollmentDetails(id, user.id);
  }

  @Post('lessons/:lessonId/progress')
  @ApiOperation({ summary: 'Update lesson progress' })
  async updateLessonProgress(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: User,
    @Body() updateProgressDto: UpdateProgressDto,
  ) {
    return this.enrollmentsService.updateLessonProgress(
      user.id,
      lessonId,
      updateProgressDto.watchTime,
      updateProgressDto.isCompleted,
    );
  }

  @Get('courses/:courseId/progress')
  @ApiOperation({ summary: 'Get course progress' })
  async getCourseProgress(
    @Param('courseId') courseId: string,
    @CurrentUser() user: User,
  ) {
    return this.enrollmentsService.getCourseProgress(user.id, courseId);
  }
}
