import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import {
  CouponsService, CreateCouponDto, UpdateCouponDto, ValidateCouponDto,
} from './coupons.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Role } from '@prisma/client';

@ApiTags('Coupons')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('coupons')
export class CouponsController {
  constructor(private readonly couponsService: CouponsService) {}

  // ── Admin ──────────────────────────────────────────────────────────────────

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Create a coupon (admin only)' })
  create(@Body() dto: CreateCouponDto) {
    return this.couponsService.createCoupon(dto);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'List all coupons (admin only)' })
  list(@Query() pagination: PaginationDto) {
    return this.couponsService.getCoupons(pagination);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Update a coupon (admin only)' })
  update(@Param('id') id: string, @Body() dto: UpdateCouponDto) {
    return this.couponsService.updateCoupon(id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Delete a coupon (admin only)' })
  delete(@Param('id') id: string) {
    return this.couponsService.deleteCoupon(id);
  }

  // ── User: validate & discover ─────────────────────────────────────────────

  @Post('validate')
  @ApiOperation({ summary: 'Validate a coupon code and get the discounted price' })
  validate(@Body() dto: ValidateCouponDto) {
    return this.couponsService.validateCoupon(dto);
  }

  @Get('active')
  @ApiOperation({ summary: 'List currently active/available coupons (any authenticated user)' })
  listActive(@Query() pagination: PaginationDto) {
    return this.couponsService.getActiveCoupons(pagination);
  }
}
