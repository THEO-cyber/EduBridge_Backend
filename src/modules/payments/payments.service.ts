import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import {
  PaymentStatus,
  TransactionType,
  EnrollmentStatus,
} from '@prisma/client';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private stripe: Stripe;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.stripe = new Stripe(
      this.configService.get<string>('stripe.secretKey') || '',
      {
        apiVersion: '2023-10-16',
      },
    );
  }

  async createPaymentIntent(
    userId: string,
    createPaymentDto: CreatePaymentDto,
  ) {
    // Validate course exists
    const course = await this.prisma.course.findUnique({
      where: { id: createPaymentDto.courseId },
      include: { instructor: true },
    });

    if (!course) {
      throw new NotFoundException('Course not found');
    }

    // Check if user is already enrolled
    const existingEnrollment = await this.prisma.enrollment.findUnique({
      where: {
        userId_courseId: {
          userId,
          courseId: createPaymentDto.courseId,
        },
      },
    });

    if (existingEnrollment) {
      throw new BadRequestException('Already enrolled in this course');
    }

    // Calculate final amount after discount/coupon
    let finalAmount = createPaymentDto.amount;
    let appliedCoupon = null;

    if (createPaymentDto.couponCode) {
      const coupon = await this.prisma.coupon.findUnique({
        where: { code: createPaymentDto.couponCode },
      });

      if (coupon && this.isCouponValid(coupon, createPaymentDto.courseId)) {
        finalAmount = this.calculateDiscountedPrice(finalAmount, coupon);
        appliedCoupon = coupon;
      }
    }

    // Apply course discount if available
    if (course.discountPrice && Number(course.discountPrice) < finalAmount) {
      finalAmount = Number(course.discountPrice);
    }

    // Create Stripe PaymentIntent
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(finalAmount * 100), // Convert to cents
      currency: (createPaymentDto.currency || 'usd').toLowerCase(),
      metadata: {
        userId,
        courseId: createPaymentDto.courseId,
        type: createPaymentDto.type,
        instructorId: course.instructorId,
        originalAmount: createPaymentDto.amount.toString(),
        finalAmount: finalAmount.toString(),
        couponCode: appliedCoupon?.code || '',
      },
    });

    // Create payment record
    const payment = await this.prisma.payment.create({
      data: {
        userId,
        amount: finalAmount,
        currency: createPaymentDto.currency,
        status: PaymentStatus.PENDING,
        type: createPaymentDto.type,
        stripePaymentIntentId: paymentIntent.id,
        description: `Course purchase: ${course.title}`,
        metadata: {
          courseId: createPaymentDto.courseId,
          instructorId: course.instructorId,
          couponCode: appliedCoupon?.code,
        },
      },
    });

    return {
      paymentId: payment.id,
      clientSecret: paymentIntent.client_secret,
      amount: finalAmount,
      currency: createPaymentDto.currency,
      course: {
        id: course.id,
        title: course.title,
        thumbnail: course.thumbnail,
      },
    };
  }

  async handleStripeWebhook(signature: string, payload: string) {
    const webhookSecret = this.configService.get<string>(
      'stripe.webhookSecret',
    );

    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        webhookSecret,
      );
    } catch (err) {
      this.logger.error(
        `Webhook signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('Invalid webhook signature');
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSuccess(
          event.data.object as Stripe.PaymentIntent,
        );
        break;
      case 'payment_intent.payment_failed':
        await this.handlePaymentFailure(
          event.data.object as Stripe.PaymentIntent,
        );
        break;
      default:
        this.logger.log(`Unhandled event type: ${event.type}`);
    }

    return { received: true };
  }

  private async handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    const metadata = paymentIntent.metadata;

    try {
      await this.prisma.$transaction(async (tx) => {
        // Update payment status
        await tx.payment.update({
          where: { stripePaymentIntentId: paymentIntent.id },
          data: { status: PaymentStatus.COMPLETED },
        });

        // Create enrollment
        await tx.enrollment.create({
          data: {
            userId: metadata.userId,
            courseId: metadata.courseId,
            price: Number(metadata.finalAmount),
            currency: paymentIntent.currency.toUpperCase(),
            status: EnrollmentStatus.ACTIVE,
          },
        });

        // Update course statistics
        await tx.course.update({
          where: { id: metadata.courseId },
          data: {
            totalEnrollments: { increment: 1 },
            totalRevenue: { increment: Number(metadata.finalAmount) },
          },
        });

        // Update instructor statistics
        const instructorEarnings = Number(metadata.finalAmount) * 0.7; // 70% to instructor
        await tx.instructorProfile.update({
          where: { userId: metadata.instructorId },
          data: {
            totalRevenue: { increment: instructorEarnings },
            totalStudents: { increment: 1 },
          },
        });

        // Update coupon usage if applied
        if (metadata.couponCode) {
          await tx.coupon.update({
            where: { code: metadata.couponCode },
            data: { usedCount: { increment: 1 } },
          });
        }

        // Create user analytics record if doesn't exist
        await tx.userAnalytics.upsert({
          where: { userId: metadata.userId },
          create: {
            userId: metadata.userId,
            totalCoursesEnrolled: 1,
            totalSpent: Number(metadata.finalAmount),
          },
          update: {
            totalCoursesEnrolled: { increment: 1 },
            totalSpent: { increment: Number(metadata.finalAmount) },
          },
        });
      });

      this.logger.log(`Payment successful for course ${metadata.courseId}`);
    } catch (error) {
      this.logger.error(
        `Failed to process successful payment: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private async handlePaymentFailure(paymentIntent: Stripe.PaymentIntent) {
    try {
      await this.prisma.payment.update({
        where: { stripePaymentIntentId: paymentIntent.id },
        data: { status: PaymentStatus.FAILED },
      });

      this.logger.log(`Payment failed for PaymentIntent ${paymentIntent.id}`);
    } catch (error) {
      this.logger.error(`Failed to process payment failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async getPaymentHistory(
    userId: string,
    paginationDto: { page: number; limit: number },
  ) {
    const { page, limit } = paginationDto;
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where: { userId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payment.count({ where: { userId } }),
    ]);

    return {
      payments,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    };
  }

  private isCouponValid(coupon: any, courseId: string): boolean {
    if (!coupon.isActive) return false;
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit)
      return false;
    if (coupon.validFrom > new Date()) return false;
    if (coupon.validUntil < new Date()) return false;
    if (
      coupon.applicableCourses.length > 0 &&
      !coupon.applicableCourses.includes(courseId)
    ) {
      return false;
    }
    return true;
  }

  private calculateDiscountedPrice(originalPrice: number, coupon: any): number {
    let discount = 0;

    if (coupon.discountType === 'percentage') {
      discount = (originalPrice * Number(coupon.discountValue)) / 100;
      if (coupon.maximumDiscount) {
        discount = Math.min(discount, Number(coupon.maximumDiscount));
      }
    } else {
      discount = Number(coupon.discountValue);
    }

    return Math.max(0, originalPrice - discount);
  }
}
