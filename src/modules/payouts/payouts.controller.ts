import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PayoutsService, RequestPayoutDto } from './payouts.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role, User } from '@prisma/client';

@ApiTags('Payouts')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}

  @Get('dashboard')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Get instructor earnings dashboard' })
  dashboard(@CurrentUser() user: User) {
    return this.payoutsService.getEarningsDashboard(user.id);
  }

  @Post('connect')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Get Stripe Connect onboarding link' })
  connectStripe(@CurrentUser() user: User) {
    return this.payoutsService.createConnectOnboardingLink(user.id);
  }

  @Post('request')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Request a payout to your connected Stripe account' })
  requestPayout(@CurrentUser() user: User, @Body() dto: RequestPayoutDto) {
    return this.payoutsService.requestPayout(user.id, dto);
  }

  @Get('history')
  @UseGuards(RolesGuard)
  @Roles(Role.INSTRUCTOR)
  @ApiOperation({ summary: 'Get your payout history' })
  history(@CurrentUser() user: User, @Query() pagination: PaginationDto) {
    return this.payoutsService.getPayoutHistory(user.id, pagination);
  }

  @Get('admin/all')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all payouts (admin)' })
  adminAll(@Query() pagination: PaginationDto) {
    return this.payoutsService.adminListPayouts(pagination);
  }
}
