import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NkwaService } from '../../common/nkwa/nkwa.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PaymentStatus, TransactionType, EnrollmentStatus } from '@prisma/client';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly nkwa: NkwaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private get currency(): string {
    return this.configService.get<string>('currency') || 'XAF';
  }

  private get instructorShare(): number {
    const s = this.configService.get<number>('instructorShare');
    return typeof s === 'number' && s > 0 && s < 1 ? s : 0.7;
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
        data: { userId, courseId, price: 0, currency: this.currency, status: 'ACTIVE' },
      }),
      this.prisma.course.update({
        where: { id: courseId },
        data: { totalEnrollments: { increment: 1 } },
      }),
    ]);

    return { enrolled: true, courseId };
  }

  /**
   * Start a MoMo/Orange Money payment via Nkwa. The amount is ALWAYS derived
   * server-side from the course price (+ optional coupon) — the client-supplied
   * amount is ignored. The customer approves the charge on their handset; the
   * final enrollment is granted once Nkwa confirms success (webhook or poll).
   */
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

    // Authoritative server-side amount (XAF, zero-decimal → integer).
    const listPrice =
      course.discountPrice && Number(course.discountPrice) < Number(course.price)
        ? Number(course.discountPrice)
        : Number(course.price);

    let finalAmount = listPrice;
    let appliedCoupon: any = null;

    if (dto.couponCode) {
      const coupon = await this.prisma.coupon.findUnique({ where: { code: dto.couponCode } });
      if (coupon && this.isCouponValid(coupon, dto.courseId)) {
        const priorUse = await this.prisma.payment.count({
          where: {
            userId,
            status: PaymentStatus.COMPLETED,
            metadata: { path: ['couponCode'], equals: coupon.code },
          },
        });
        if (priorUse > 0) throw new BadRequestException('You have already used this coupon');
        finalAmount = this.applyDiscount(finalAmount, coupon);
        appliedCoupon = coupon;
      }
    }

    finalAmount = Math.max(1, Math.round(finalAmount));

    // Kick off the Nkwa collection (prompts the customer's phone).
    const collection = await this.nkwa.collect(
      finalAmount,
      dto.phoneNumber,
      `Course purchase: ${course.title}`,
    );

    const payment = await this.prisma.payment.create({
      data: {
        userId,
        amount: finalAmount,
        currency: this.currency,
        status: PaymentStatus.PENDING,
        type: dto.type ?? TransactionType.COURSE_PURCHASE,
        nkwaPaymentId: collection.id,
        phoneNumber: dto.phoneNumber,
        description: `Course purchase: ${course.title}`,
        metadata: {
          courseId: dto.courseId,
          instructorId: course.instructorId,
          couponCode: appliedCoupon?.code,
          finalAmount,
        },
      },
    });

    return {
      paymentId: payment.id,
      nkwaPaymentId: collection.id,
      status: collection.status, // pending — customer must approve on their phone
      operator: collection.telecomOperator,
      amount: finalAmount,
      currency: this.currency,
      course: { id: course.id, title: course.title, thumbnail: course.thumbnail },
    };
  }

  /**
   * Client polls this after starting a payment. It asks Nkwa for the
   * authoritative status and, on success, finalizes the enrollment (idempotent).
   */
  async getPaymentStatus(userId: string, paymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.userId !== userId) throw new ForbiddenException('Access denied');

    const status = await this.finalizeFromNkwa(payment.nkwaPaymentId ?? undefined);
    return { paymentId: payment.id, status };
  }

  /** Nkwa webhook — verify signature if configured, then re-fetch to be sure. */
  async handleNkwaWebhook(signature: string | undefined, timestamp: string | undefined, rawBody: Buffer) {
    let body: any = {};
    try {
      body = rawBody?.length ? JSON.parse(rawBody.toString('utf8')) : {};
    } catch {
      throw new BadRequestException('Invalid webhook payload');
    }

    // Signature is best-effort; the authoritative check is re-fetching the
    // payment from Nkwa inside finalizeFromNkwa, so a spoofed body cannot grant
    // access to a payment that did not actually succeed.
    const verified = this.nkwa.verifyWebhook(signature, timestamp, rawBody);
    if (!verified) {
      this.logger.warn('Nkwa webhook signature not verified — relying on authoritative re-fetch.');
    }

    const nkwaPaymentId = body?.id || body?.data?.id;
    if (!nkwaPaymentId) return { received: true };

    await this.finalizeFromNkwa(nkwaPaymentId);
    return { received: true };
  }

  /**
   * Refund a completed payment: reverse the enrollment and disburse the amount
   * back to the payer's MoMo/Orange number via Nkwa.
   */
  async refundPayment(userId: string, paymentId: string, reason?: string) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });

    if (!payment) throw new NotFoundException('Payment not found');
    if (payment.userId !== userId) throw new ForbiddenException('Not your payment');
    if (payment.status !== 'COMPLETED') throw new BadRequestException('Only completed payments can be refunded');
    if (!payment.phoneNumber) throw new BadRequestException('No payer phone number on record');

    const courseId = (payment.metadata as any)?.courseId;
    const instructorId = (payment.metadata as any)?.instructorId;

    // Disburse the refund back to the payer.
    const disbursement = await this.nkwa.disburse(
      Number(payment.amount),
      payment.phoneNumber,
      `Refund${reason ? `: ${reason}` : ''}`,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'REFUNDED', refundId: disbursement.id },
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
        if (instructorId) {
          await tx.instructorProfile.update({
            where: { userId: instructorId },
            data: {
              totalRevenue: { decrement: Number(payment.amount) * this.instructorShare },
              totalStudents: { decrement: 1 },
            },
          });
        }
      }
    });

    this.logger.log(`Refunded payment ${paymentId} — Nkwa disbursement ${disbursement.id}`);
    return { success: true, refundId: disbursement.id, amount: Number(payment.amount) };
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

    const meta = (payment.metadata as Record<string, any>) ?? {};

    let course: { title: string; instructor: { firstName: string; lastName: string } } | null = null;
    if (meta.courseId) {
      course = (await this.prisma.course.findUnique({
        where: { id: meta.courseId },
        select: {
          title: true,
          instructor: { select: { firstName: true, lastName: true } },
        },
      })) as any;
    }

    return {
      invoiceNumber: `INV-${payment.id.slice(-8).toUpperCase()}`,
      issuedAt: payment.createdAt,
      status: payment.status,
      customer: {
        name: `${payment.user.firstName} ${payment.user.lastName}`,
        email: payment.user.email,
      },
      items: course
        ? [{ description: `Course: ${course.title}`, instructorName: `${course.instructor.firstName} ${course.instructor.lastName}`, amount: Number(payment.amount) }]
        : [{ description: payment.description ?? 'Purchase', amount: Number(payment.amount) }],
      subtotal: Number(payment.amount),
      discount: meta.originalPrice ? Number(meta.originalPrice) - Number(payment.amount) : 0,
      total: Number(payment.amount),
      currency: payment.currency,
      providerPaymentId: payment.nkwaPaymentId,
      paymentType: payment.type,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Ask Nkwa for the authoritative status of a payment and finalize accordingly.
   * Idempotent: safe to call from both the webhook and the client poll.
   */
  private async finalizeFromNkwa(nkwaPaymentId?: string): Promise<PaymentStatus> {
    if (!nkwaPaymentId) return PaymentStatus.PENDING;

    const local = await this.prisma.payment.findUnique({
      where: { nkwaPaymentId },
      select: { status: true },
    });
    if (local?.status === PaymentStatus.COMPLETED) return PaymentStatus.COMPLETED;

    const remote = await this.nkwa.getPayment(nkwaPaymentId);

    if (remote.status === 'success') {
      await this.grantEnrollment(nkwaPaymentId);
      return PaymentStatus.COMPLETED;
    }
    if (remote.status === 'failed' || remote.status === 'canceled') {
      await this.prisma.payment.updateMany({
        where: { nkwaPaymentId, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED },
      });
      return PaymentStatus.FAILED;
    }
    return PaymentStatus.PENDING;
  }

  private async grantEnrollment(nkwaPaymentId: string) {
    const payment = await this.prisma.payment.findUnique({ where: { nkwaPaymentId } });
    if (!payment) return;
    if (payment.status === PaymentStatus.COMPLETED) return; // idempotency

    const m = (payment.metadata as any) ?? {};
    const userId = payment.userId;
    const courseId = m.courseId;
    const instructorId = m.instructorId;
    const finalAmount = Number(m.finalAmount ?? payment.amount);

    // Skip if already enrolled (idempotency safety net).
    const existingEnrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { id: true },
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.COMPLETED },
        });

        if (!existingEnrollment) {
          await tx.enrollment.create({
            data: {
              userId,
              courseId,
              price: finalAmount,
              currency: payment.currency,
              status: EnrollmentStatus.ACTIVE,
            },
          });

          await tx.course.update({
            where: { id: courseId },
            data: {
              totalEnrollments: { increment: 1 },
              totalRevenue: { increment: finalAmount },
            },
          });

          if (instructorId) {
            await tx.instructorProfile.update({
              where: { userId: instructorId },
              data: {
                totalRevenue: { increment: finalAmount * this.instructorShare },
                totalStudents: { increment: 1 },
              },
            });
          }

          if (m.couponCode) {
            await tx.coupon.updateMany({
              where: { code: m.couponCode },
              data: { usedCount: { increment: 1 } },
            });
          }

          await tx.userAnalytics.upsert({
            where: { userId },
            create: { userId, totalCoursesEnrolled: 1, totalSpent: finalAmount },
            update: {
              totalCoursesEnrolled: { increment: 1 },
              totalSpent: { increment: finalAmount },
            },
          });
        }
      });

      // Non-critical side effects outside the transaction.
      try {
        const course = await this.prisma.course.findUnique({ where: { id: courseId }, select: { title: true } });
        if (course && !existingEnrollment) {
          await this.notificationsService.notifyPaymentSuccess(userId, course.title, finalAmount, payment.currency, nkwaPaymentId);
          await this.notificationsService.notifyEnrollmentSuccess(userId, course.title, courseId);
        }
      } catch (notifErr: any) {
        this.logger.warn(`Notification failed: ${notifErr.message}`);
      }

      this.logger.log(`Payment success: course=${courseId} user=${userId}`);
    } catch (error: any) {
      this.logger.error(`Payment finalization failed: ${error.message}`, error.stack);
      throw error;
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
