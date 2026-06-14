import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { SystemSettingsService } from './system-settings.service';

@ApiTags('Settings')
@Public()
@Controller('settings')
export class PublicSettingsController {
  constructor(private readonly systemSettingsService: SystemSettingsService) {}

  @Get('public')
  @ApiOperation({ summary: 'Get all publicly visible platform settings (no auth required)' })
  getPublicSettings() {
    return this.systemSettingsService.listPublic();
  }
}
