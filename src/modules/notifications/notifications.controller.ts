import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  ParseBoolPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { NotificationsService } from './notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { User } from '@prisma/client';

class RegisterDeviceTokenDto {
  @IsString()
  token!: string;

  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: 'android' | 'ios' | 'web';
}

@ApiTags('Notifications')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ── FCM device token ────────────────────────────────────────────────────────

  @Post('device-token')
  @ApiOperation({ summary: 'Register FCM device token for push notifications' })
  @ApiBody({ type: RegisterDeviceTokenDto })
  async registerDeviceToken(
    @CurrentUser() user: User,
    @Body() dto: RegisterDeviceTokenDto,
  ) {
    return this.notificationsService.saveDeviceToken(
      user.id,
      dto.token,
      dto.platform ?? 'android',
    );
  }

  @Delete('device-token')
  @ApiOperation({ summary: 'Remove FCM device token (on logout)' })
  @ApiBody({ schema: { properties: { token: { type: 'string' } } } })
  async removeDeviceToken(
    @CurrentUser() user: User,
    @Body('token') token: string,
  ) {
    return this.notificationsService.removeDeviceToken(user.id, token);
  }

  // ── In-app notifications ────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'Get user notifications' })
  @ApiQuery({ name: 'unreadOnly', required: false, type: Boolean })
  async getUserNotifications(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
    @Query('unreadOnly', new ParseBoolPipe({ optional: true }))
    unreadOnly?: boolean,
  ) {
    return this.notificationsService.getUserNotifications(
      user.id,
      paginationDto,
      unreadOnly ?? false,
    );
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark notification as read' })
  async markAsRead(@CurrentUser() user: User, @Param('id') id: string) {
    return this.notificationsService.markAsRead(user.id, id);
  }

  @Post('mark-all-read')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllAsRead(@CurrentUser() user: User) {
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a notification' })
  async deleteNotification(@CurrentUser() user: User, @Param('id') id: string) {
    return this.notificationsService.deleteNotification(user.id, id);
  }
}
