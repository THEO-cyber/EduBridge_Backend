import {
  Injectable, NotFoundException, BadRequestException, ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  IsString, IsOptional, IsNumber, IsBoolean, IsEnum, IsDateString,
  IsArray, Min, Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCouponDto {
  @IsString() code!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsEnum(['percentage', 'fixed']) discountType!: 'percentage' | 'fixed';
  @IsNumber() @Type(() => Number) @Min(0) discountValue!: number;
  @IsOptional() @IsNumber() @Type(() => Number) @Min(0) minimumAmount?: number;
  @IsOptional() @IsNumber() @Type(() => Number) @Min(0) maximumDiscount?: number;
  @IsOptional() @IsNumber() @Type(() => Number) @Min(1) usageLimit?: number;
  @IsDateString() validFrom!: string;
  @IsDateString() validUntil!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) applicableCourses?: string[];
}

export class UpdateCouponDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Type(() => Number) discountValue?: number;
  @IsOptional() @IsNumber() @Type(() => Number) usageLimit?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsDateString() validFrom?: string;
  @IsOptional() @IsDateString() validUntil?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) applicableCourses?: string[];
}

export class ValidateCouponDto {
  @IsString() code!: string;
  @IsString() courseId!: string;
  @IsNumber() @Type(() => Number) @Min(0) amount!: number;
}

@Injectable()
export class CouponsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Admin ────────────────────────────────────────────────────────────────

  async createCoupon(dto: CreateCouponDto) {
    const existing = await this.prisma.coupon.findUnique({ where: { code: dto.code } });
    if (existing) throw new BadRequestException('Coupon code already exists');

    return this.prisma.coupon.create({
      data: {
        code:              dto.code.toUpperCase().trim(),
        name:              dto.name,
        description:       dto.description,
        discountType:      dto.discountType,
        discountValue:     dto.discountValue,
        minimumAmount:     dto.minimumAmount,
        maximumDiscount:   dto.maximumDiscount,
        usageLimit:        dto.usageLimit,
        validFrom:         new Date(dto.validFrom),
        validUntil:        new Date(dto.validUntil),
        applicableCourses: dto.applicableCourses ?? [],
      },
    });
  }

  async getCoupons(pagination: PaginationDto) {
    const { page, limit, skip } = pagination;
    const [coupons, total] = await Promise.all([
      this.prisma.coupon.findMany({ skip, take: limit, orderBy: { createdAt: 'desc' } }),
      this.prisma.coupon.count(),
    ]);
    return { coupons, pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) } };
  }

  async updateCoupon(id: string, dto: UpdateCouponDto) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new NotFoundException('Coupon not found');

    return this.prisma.coupon.update({
      where: { id },
      data: {
        name:              dto.name,
        description:       dto.description,
        discountValue:     dto.discountValue,
        usageLimit:        dto.usageLimit,
        isActive:          dto.isActive,
        validFrom:         dto.validFrom ? new Date(dto.validFrom) : undefined,
        validUntil:        dto.validUntil ? new Date(dto.validUntil) : undefined,
        applicableCourses: dto.applicableCourses,
      },
    });
  }

  async deleteCoupon(id: string) {
    const coupon = await this.prisma.coupon.findUnique({ where: { id } });
    if (!coupon) throw new NotFoundException('Coupon not found');
    await this.prisma.coupon.delete({ where: { id } });
    return { success: true };
  }

  // ─── User: validate ───────────────────────────────────────────────────────

  async validateCoupon(dto: ValidateCouponDto) {
    const coupon = await this.prisma.coupon.findUnique({
      where: { code: dto.code.toUpperCase().trim() },
    });

    if (!coupon) throw new NotFoundException('Coupon not found');
    if (!coupon.isActive) throw new BadRequestException('Coupon is inactive');
    if (new Date() < coupon.validFrom)
      throw new BadRequestException('Coupon is not yet valid');
    if (new Date() > coupon.validUntil)
      throw new BadRequestException('Coupon has expired');
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit)
      throw new BadRequestException('Coupon usage limit reached');
    if (coupon.minimumAmount && dto.amount < Number(coupon.minimumAmount))
      throw new BadRequestException(
        `Minimum order amount is ${Number(coupon.minimumAmount).toFixed(2)}`,
      );
    if (
      coupon.applicableCourses.length > 0 &&
      !coupon.applicableCourses.includes(dto.courseId)
    ) {
      throw new BadRequestException('Coupon is not valid for this course');
    }

    // Calculate discount
    let discount = 0;
    if (coupon.discountType === 'percentage') {
      discount = (dto.amount * Number(coupon.discountValue)) / 100;
      if (coupon.maximumDiscount) {
        discount = Math.min(discount, Number(coupon.maximumDiscount));
      }
    } else {
      discount = Number(coupon.discountValue);
    }

    const finalAmount = Math.max(0, dto.amount - discount);

    return {
      valid: true,
      code:          coupon.code,
      discountType:  coupon.discountType,
      discountValue: Number(coupon.discountValue),
      discount:      Math.round(discount * 100) / 100,
      finalAmount:   Math.round(finalAmount * 100) / 100,
      savings:       Math.round(discount * 100) / 100,
    };
  }

  // ─── Student-facing active coupon listing ─────────────────────────────────

  async getActiveCoupons(pagination: PaginationDto) {
    const { page = 1, limit = 20, skip = 0 } = pagination;
    const now = new Date();

    const [coupons, total] = await Promise.all([
      this.prisma.coupon.findMany({
        where: {
          isActive:   true,
          validFrom:  { lte: now },
          validUntil: { gte: now },
        },
        select: {
          code:             true,
          name:             true,
          description:      true,
          discountType:     true,
          discountValue:    true,
          minimumAmount:    true,
          maximumDiscount:  true,
          validUntil:       true,
          applicableCourses: true,
        },
        skip,
        take: limit,
        orderBy: { validUntil: 'asc' },
      }),
      this.prisma.coupon.count({
        where: { isActive: true, validFrom: { lte: now }, validUntil: { gte: now } },
      }),
    ]);

    return {
      coupons,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
  }
}
