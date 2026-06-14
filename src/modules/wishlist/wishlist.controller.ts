import { Controller, Get, Post, Delete, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { WishlistService } from './wishlist.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { User } from '@prisma/client';

@ApiTags('Wishlist')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('wishlist')
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @ApiOperation({ summary: 'Get your wishlist' })
  getWishlist(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    return this.wishlistService.getWishlist(user.id, pagination);
  }

  @Post(':courseId')
  @ApiOperation({ summary: 'Add course to wishlist' })
  add(@CurrentUser() user: User, @Param('courseId') courseId: string) {
    return this.wishlistService.addToWishlist(user.id, courseId);
  }

  @Delete(':courseId')
  @ApiOperation({ summary: 'Remove course from wishlist' })
  remove(@CurrentUser() user: User, @Param('courseId') courseId: string) {
    return this.wishlistService.removeFromWishlist(user.id, courseId);
  }

  @Get(':courseId/check')
  @ApiOperation({ summary: 'Check if a course is in your wishlist' })
  check(@CurrentUser() user: User, @Param('courseId') courseId: string) {
    return this.wishlistService.isInWishlist(user.id, courseId);
  }
}
