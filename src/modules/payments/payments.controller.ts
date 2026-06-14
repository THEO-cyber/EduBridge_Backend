import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Query,
  Headers,
  RawBody,
  UseGuards,
} from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';

class RefundDto {
  @IsOptional() @IsString() reason?: string;
}
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { User } from '@prisma/client';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('enroll-free/:courseId')
  @ApiOperation({ summary: 'Enroll in a free course (price = 0) without Stripe' })
  async enrollFree(@CurrentUser() user: User, @Param('courseId') courseId: string) {
    return this.paymentsService.enrollFree(user.id, courseId);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post('create-intent')
  @ApiOperation({ summary: 'Create payment intent for course purchase' })
  async createPaymentIntent(
    @CurrentUser() user: User,
    @Body() createPaymentDto: CreatePaymentDto,
  ) {
    return this.paymentsService.createPaymentIntent(user.id, createPaymentDto);
  }

  @Public()
  @Post('webhook')
  @ApiOperation({ summary: 'Stripe webhook endpoint (raw body required for signature)' })
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @RawBody() payload: Buffer,
  ) {
    return this.paymentsService.handleStripeWebhook(signature, payload);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Post(':id/refund')
  @ApiOperation({ summary: 'Refund a completed payment' })
  async refund(
    @Param('id') id: string,
    @CurrentUser() user: User,
    @Body() dto: RefundDto,
  ) {
    return this.paymentsService.refundPayment(user.id, id, dto.reason);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Get('history')
  @ApiOperation({ summary: 'Get user payment history' })
  async getPaymentHistory(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.paymentsService.getPaymentHistory(
      user.id,
      paginationDto.page,
      paginationDto.limit,
    );
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Get(':id/invoice')
  @ApiOperation({ summary: 'Get invoice/receipt for a specific payment' })
  async getInvoice(@Param('id') id: string, @CurrentUser() user: User) {
    return this.paymentsService.getInvoice(user.id, id);
  }
}
