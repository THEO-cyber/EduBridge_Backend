import {
  Controller, Post, Get, Patch, Param, Body, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ApplicationsService, SubmitApplicationDto, ReviewApplicationDto, PublicInstructorApplyDto, ListApplicationsQueryDto } from './applications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role, User } from '@prisma/client';

@ApiTags('Instructor Applications')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('applications')
export class ApplicationsController {
  constructor(private readonly applicationsService: ApplicationsService) {}

  @Public()
  @Post('instructor/apply')
  @ApiOperation({
    summary: 'Apply to become an instructor without an account. The account is created only if an admin approves.',
  })
  applyPublic(@Body() dto: PublicInstructorApplyDto) {
    return this.applicationsService.applyPublic(dto);
  }

  @Post('instructor')
  @ApiOperation({ summary: 'Apply to become an instructor (existing signed-in user)' })
  submit(@CurrentUser() user: User, @Body() dto: SubmitApplicationDto) {
    return this.applicationsService.submit(user.id, dto);
  }

  @Get('instructor/mine')
  @ApiOperation({ summary: 'Get my instructor application status' })
  getMyApplication(@CurrentUser() user: User) {
    return this.applicationsService.getMyApplication(user.id);
  }

  // ── Admin ─────────────────────────────────────────────────────────────────

  @Get('instructor')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List instructor applications (Admin)' })
  adminList(@Query() query: ListApplicationsQueryDto) {
    return this.applicationsService.adminList(query, query.status);
  }

  @Get('instructor/stats')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Get application statistics (Admin)' })
  getStats() {
    return this.applicationsService.getStats();
  }

  @Patch('instructor/:id/review')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Approve or reject an instructor application (Admin)' })
  review(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: ReviewApplicationDto,
  ) {
    return this.applicationsService.review(user.id, id, dto);
  }
}
