import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, TransactionType, EnrollmentStatus } from '@prisma/client';
import Stripe from 'stripe';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
  ) {
    const secretKey = this.configService.get<string>('stripe.secretKey') || '';
    if (!secretKey) this.logger.warn('STRIPE_SECRET_KEY is not set');

    this.stripe = new Stripe(secretKey, { apiVersion: '2023-10-16' });
  }

  async enrollFree(userId: string, courseId: string) {
    const course = await this.prisma.course.findUnique({ where: { id: courseId } });
    if (!course) throw new NotFoundException('Course not found');
    if (Number(course.price) > 0) throw new BadRequestException('This course requires payment');

    const existing = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
    });
    if (existing) throw new BadRequestException('Already enrolled');

    await this.prisma.$transaction([
      this.prisma.enrollment.create({
        data: { userId, courseId, price: 0, currency: 'USD', status: 'ACTIVE' },
      }),
      this.prisma.course.update({
        where: { id: courseId },
        data: { totalEnrollments: { increment: 1 } },
      }),
    ]);

    return { enrolled: true, courseId };
  }

  async createPaymentIntent(userId: string, dto: CreatePaymentDto) {
    const course = await this.prisma.course.findUnique({
      where: { id: dto.courseId },
      include: { instructor: true },
    });

    if (!course) throw new NotFoundException('Course not found');

    const existing = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId: dto.courseId } },
    });
    if (existing) throw new BadRequestException('Already enrolled in this course');

    let finalAmount = dto.amount;
    let appliedCoupon: any = null;

    if (dto.couponCode) {
      const coupon = await this.prisma.coupon.findUnique({ where: { code: dto.couponCode } });
      if (coupon && this.isCouponValid(coupon, dto.courseId)) {
        finalAmount = this.applyDiscount(finalAmount, coupon);
        appliedCoupon = coupon;
      }
    }

    if (course.discountPrice && Number(course.discountPrice) < finalAmount) {
      finalAmount = Number(course.discountPrice);
    }

    // Clamp to $0.50 minimum (Stripe minimum charge)
    finalAmount = Math.max(0.5, finalAmount);

    const paymentIntent = await this.stripe.paymentIntents.create({
      amount: Math.round(finalAmount * 100),
      currency: (dto.currency || 'usd').toLowerCase(),
      metadata: {
        userId,
        courseId: dto.courseId,
        type: dto.type,
        instructorId: course.instructorId,
        originalAmount: dto.amount.toString(),
        finalAmount: finalAmount.toString(),
        couponCode: appliedCoupon?.code || '',
      },
    });

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        amount: finalAmount,
        currency: dto.currency || 'USD',
        status: PaymentStatus.PENDING,
        type: dto.type,
        stripePaymentIntentId: paymentIntent.id,
        description: `Course purchase: ${course.title}`,
        metadata: {
          courseId: dto.courseId,
          instructorId: course.instructorId,
          couponCode: appliedCoupon?.code,
        },
      },
    });

    return {
      paymentId: payment.id,
      clientSecret: paymentIntent.client_secret,
      amount: finalAmount,
      currency: dto.currency || 'USD',
      course: { id: course.id, title: course.title, thumbnail: course.thumbnail },
    };
  }

  async handleStripeWebhook(signature: string, rawBody: Buffer) {
    const webhookSecret = this.configService.get<string>('stripe.webhookSecret') || '';
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      this.logger.error(`Webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSuccess(event.data.object as Stripe.PaymentIntent);
        break;
      case 'payment_intent.payment_failed':
        await this.handlePaymentFailure(event.data.object as Stripe.PaymentIntent);
        break;
      default:
        this.logger.debug(`Unhandled Stripe event: ${event.type}`);
    }

    return { received: true };
  }

  async refundPayment(userId: string, paymentId: string, reason?: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.userId !== userId) throw new BadRequestException('Not your payment');
    if (payment.status !== 'COMPLETED') throw new BadRequestException('Only completed payments can be refunded');
    if (!payment.stripePaymentIntentId) throw new BadRequestException('No Stripe payment found');

    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: payment.stripePaymentIntentId,
        reason: (reason as any) ?? 'requested_by_customer',
      });

      const courseId = (payment.metadata as any)?.courseId;

      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: { status: 'REFUNDED', refundId: refund.id },
        });

        if (courseId) {
          await tx.enrollment.updateMany({
            where: { userId, courseId },
            data: { status: 'REFUNDED', refundedAt: new Date() },
          });

          await tx.course.update({
            where: { id: courseId },
            data: {
              totalEnrollments: { decrement: 1 },
              totalRevenue: { decrement: Number(payment.amount) },
            },
          });

          // Claw back instructor share
          const instructorId = (payment.metadata as any)?.instructorId;
          if (instructorId) {
            await tx.instructorProfile.update({
              where: { userId: instructorId },
              data: {
                totalRevenue: { decrement: Number(payment.amount) * 0.7 },
                totalStudents: { decrement: 1 },
              },
            });
          }
        }
      });

      this.logger.log(`Refunded payment ${paymentId} — Stripe refund ${refund.id}`);
      return { success: true, refundId: refund.id, amount: Number(payment.amount) };
    } catch (err: any) {
      this.logger.error(`Refund failed: ${err.message}`);
      throw new BadRequestException(`Refund failed: ${err.message}`);
    }
  }

  async getPaymentHistory(userId: string, page = 1, limit = 20) {
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

    return { payments, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  async getInvoice(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { user: { select: { firstName: true, lastName: true, email: true } } },
    });

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.userId !== userId) throw new ForbiddenException('Access denied');

    const meta = payment.metadata as Record<string, any> ?? {};

    let course: { title: string; instructor: { firstName: string; lastName: string } } | null = null;
    if (meta.courseId) {
      course = await this.prisma.course.findUnique({
        where: { id: meta.courseId },
        select: {
          title: true,
          instructor: { select: { firstName: true, lastName: true } },
        },
      }) as any;
    }

    return {
      invoiceNumber: `INV-${payment.id.slice(-8).toUpperCase()}`,
      issuedAt:      payment.createdAt,
      status:        payment.status,
      customer: {
        name:  `${payment.user.firstName} ${payment.user.lastName}`,
        email: payment.user.email,
      },
      items: course
        ? [{ description: `Course: ${course.title}`, instructorName: `${course.instructor.firstName} ${course.instructor.lastName}`, amount: Number(payment.amount) }]
        : [{ description: payment.description ?? 'Purchase', amount: Number(payment.amount) }],
      subtotal:          Number(payment.amount),
      discount:          meta.originalPrice ? Number(meta.originalPrice) - Number(payment.amount) : 0,
      total:             Number(payment.amount),
      currency:          payment.currency,
      stripePaymentId:   payment.stripePaymentIntentId,
      paymentType:       payment.type,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async handlePaymentSuccess(intent: Stripe.PaymentIntent) {
    const m = intent.metadata;

    try {
      await this.prisma.$transaction(async (tx) => {
        // 1. Mark payment completed
        await tx.payment.update({
          where: { stripePaymentIntentId: intent.id },
          data: { status: PaymentStatus.COMPLETED },
        });

        // 2. Create enrollment
        await tx.enrollment.create({
          data: {
            userId: m.userId,
            courseId: m.courseId,
            price: Number(m.finalAmount),
            currency: intent.currency.toUpperCase(),
            status: EnrollmentStatus.ACTIVE,
          },
        });

        // 3. Update course stats
        await tx.course.update({
          where: { id: m.courseId },
          data: {
            totalEnrollments: { increment: 1 },
            totalRevenue: { increment: Number(m.finalAmount) },
          },
        });

        // 4. Instructor earnings (70% platform split)
        const instructorEarnings = Number(m.finalAmount) * 0.7;
        await tx.instructorProfile.update({
          where: { userId: m.instructorId },
          data: {
            totalRevenue: { increment: instructorEarnings },
            totalStudents: { increment: 1 },
          },
        });

        // 5. Increment coupon usage
        if (m.couponCode) {
          await tx.coupon.update({
            where: { code: m.couponCode },
            data: { usedCount: { increment: 1 } },
          });
        }

        // 6. User analytics
        await tx.userAnalytics.upsert({
          where: { userId: m.userId },
          create: { userId: m.userId, totalCoursesEnrolled: 1, totalSpent: Number(m.finalAmount) },
          update: {
            totalCoursesEnrolled: { increment: 1 },
            totalSpent: { increment: Number(m.finalAmount) },
          },
        });
      });

      // 7. Fire notification (outside transaction — non-critical)
      try {
        const course = await this.prisma.course.findUnique({ where: { id: m.courseId }, select: { title: true } });
        if (course) {
          await this.notificationsService.notifyPaymentSuccess(
            m.userId,
            course.title,
            Number(m.finalAmount),
            intent.currency,
            intent.id,
          );
          await this.notificationsService.notifyEnrollmentSuccess(m.userId, course.title, m.courseId);
        }
      } catch (notifErr: any) {
        this.logger.warn(`Notification failed: ${notifErr.message}`);
      }

      this.logger.log(`Payment success: course=${m.courseId} user=${m.userId}`);
    } catch (error: any) {
      this.logger.error(`Payment processing failed: ${error.message}`, error.stack);
      throw error;
    }
  }

  private async handlePaymentFailure(intent: Stripe.PaymentIntent) {
    try {
      await this.prisma.payment.update({
        where: { stripePaymentIntentId: intent.id },
        data: { status: PaymentStatus.FAILED },
      });
      this.logger.log(`Payment failed: ${intent.id}`);
    } catch (error: any) {
      this.logger.error(`Failed to record payment failure: ${error.message}`);
    }
  }

  private isCouponValid(coupon: any, courseId: string): boolean {
    if (!coupon.isActive) return false;
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) return false;
    if (coupon.validFrom > new Date()) return false;
    if (coupon.validUntil < new Date()) return false;
    if (coupon.applicableCourses.length > 0 && !coupon.applicableCourses.includes(courseId)) {
      return false;
    }
    return true;
  }

  private applyDiscount(price: number, coupon: any): number {
    const discount =
      coupon.discountType === 'percentage'
        ? Math.min(
            (price * Number(coupon.discountValue)) / 100,
            coupon.maximumDiscount ? Number(coupon.maximumDiscount) : Infinity,
          )
        : Number(coupon.discountValue);
    return Math.max(0, price - discount);
  }
}
