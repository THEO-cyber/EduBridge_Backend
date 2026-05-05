import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Headers,
  RawBody,
  UseGuards,
} from '@nestjs/common';
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
  @ApiOperation({ summary: 'Stripe webhook endpoint' })
  async handleWebhook(
    @Headers('stripe-signature') signature: string,
    @RawBody() payload: string,
  ) {
    return this.paymentsService.handleStripeWebhook(signature, payload);
  }

  @ApiBearerAuth('JWT-auth')
  @UseGuards(JwtAuthGuard)
  @Get('history')
  @ApiOperation({ summary: 'Get user payment history' })
  async getPaymentHistory(
    @CurrentUser() user: User,
    @Query() paginationDto: PaginationDto,
  ) {
    const pagination = {
      page: paginationDto.page || 1,
      limit: paginationDto.limit || 20,
    };
    return this.paymentsService.getPaymentHistory(user.id, pagination);
  }
}
