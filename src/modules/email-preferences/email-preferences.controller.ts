import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { EmailPreferencesService, UpdateEmailPreferenceDto } from './email-preferences.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { User } from '@prisma/client';

@ApiTags('Email Preferences')
@Controller('email-preferences')
export class EmailPreferencesController {
  constructor(private readonly emailPreferencesService: EmailPreferencesService) {}

  @Get()
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get my email preferences' })
  get(@CurrentUser() user: User) {
    return this.emailPreferencesService.getOrCreate(user.id);
  }

  @Patch()
  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update email preferences' })
  update(@CurrentUser() user: User, @Body() dto: UpdateEmailPreferenceDto) {
    return this.emailPreferencesService.update(user.id, dto);
  }

  @Get('unsubscribe/:token')
  @Public()
  @ApiOperation({ summary: 'One-click unsubscribe from all marketing emails (GDPR)' })
  unsubscribe(@Param('token') token: string) {
    return this.emailPreferencesService.unsubscribeAll(token);
  }
}
