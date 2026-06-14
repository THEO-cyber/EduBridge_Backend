import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ReviewsService, CreateReviewDto, UpdateReviewDto } from './reviews.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { User } from '@prisma/client';

@ApiTags('Reviews')
@UseGuards(JwtAuthGuard)
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a review for an enrolled course' })
  create(@CurrentUser() user: User, @Body() dto: CreateReviewDto) {
    return this.reviewsService.createReview(user.id, dto);
  }

  @Public()
  @Get('course/:courseId')
  @ApiOperation({ summary: 'Get all reviews for a course' })
  getCourseReviews(@Param('courseId') courseId: string, @Query() pagination: PaginationDto) {
    return this.reviewsService.getCourseReviews(courseId, pagination);
  }

  @Get('my/:courseId')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get your own review for a course' })
  getMyReview(@CurrentUser() user: User, @Param('courseId') courseId: string) {
    return this.reviewsService.getUserReview(user.id, courseId);
  }

  @Patch(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update your review' })
  update(@Param('id') id: string, @CurrentUser() user: User, @Body() dto: UpdateReviewDto) {
    return this.reviewsService.updateReview(id, user.id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Delete your review' })
  delete(@Param('id') id: string, @CurrentUser() user: User) {
    return this.reviewsService.deleteReview(id, user.id);
  }
}
