import { IsString, IsNumber, IsEnum, IsOptional, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { TransactionType } from '@prisma/client';

export class CreatePaymentDto {
  @ApiProperty({ example: 'course-uuid' })
  @IsString()
  courseId: string;

  // MoMo / Orange Money number that will be charged via Nkwa Pay. The operator
  // (MTN vs Orange) is auto-detected by Nkwa from the number.
  @ApiProperty({ example: '237650000000', description: 'MoMo/Orange Money phone number' })
  @IsString()
  @Matches(/^(\+?237)?[0-9]{9}$/, {
    message: 'phoneNumber must be a valid Cameroon MoMo/Orange number',
  })
  phoneNumber: string;

  // Informational only — the server always derives the actual charge from the
  // course's own price/discountPrice. This value is never used to compute the
  // amount charged.
  @ApiProperty({ example: 5000, required: false })
  @IsOptional()
  @IsNumber()
  amount?: number;

  @ApiProperty({ example: 'XAF', required: false })
  @IsOptional()
  @IsString()
  currency?: string = 'XAF';

  @ApiProperty({
    enum: TransactionType,
    example: TransactionType.COURSE_PURCHASE,
    required: false,
  })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType = TransactionType.COURSE_PURCHASE;

  @ApiProperty({ example: 'coupon-code', required: false })
  @IsOptional()
  @IsString()
  couponCode?: string;
}
