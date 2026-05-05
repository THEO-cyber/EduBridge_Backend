import { IsString, IsNumber, IsEnum, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionType } from '@prisma/client';

export class CreatePaymentDto {
  @ApiProperty({ example: 'course-uuid' })
  @IsString()
  courseId: string;

  @ApiProperty({ example: 99.99 })
  @IsNumber({ maxDecimalPlaces: 2 })
  amount: number;

  @ApiProperty({ example: 'USD', required: false })
  @IsOptional()
  @IsString()
  currency?: string = 'USD';

  @ApiProperty({
    enum: TransactionType,
    example: TransactionType.COURSE_PURCHASE,
  })
  @IsEnum(TransactionType)
  type: TransactionType;

  @ApiProperty({ example: 'coupon-code', required: false })
  @IsOptional()
  @IsString()
  couponCode?: string;
}
