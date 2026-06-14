import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../../common/email/email.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { NotificationType } from '@prisma/client';
import Stripe from 'stripe';

export class RequestPayoutDto {
  @IsNumber() @Type(() => Number) @Min(10) amount!: number;
  @IsOptional() @IsString() currency?: string;
}

export class CreateConnectAccountDto {
  @IsString() country!: string;
  @IsString() email!: string;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {
    this.stripe = new Stripe(
      this.configService.get<string>('stripe.secretKey') ?? '',
      { apiVersion: '2023-10-16' },
    );
  }

  // ── Instructor: get earnings dashboard ────────────────────────────────────

  async getEarningsDashboard(instructorId: string) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorId },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');

    const [totalRevenue, pendingPayouts, completedPayouts, recentPayouts] =
      await Promise.all([
        // Total earnings from course sales (70% of course revenue)
        this.prisma.payment.aggregate({
          where: {
            status: 'COMPLETED',
            metadata: { path: ['instructorId'], equals: instructorId },
          },
          _sum: { amount: true },
        }),
        // Pending payout requests
        this.prisma.payout.aggregate({
          where: { instructorId: profile.id, status: 'pending' },
          _sum: { amount: true },
          _count: true,
        }),
        // Completed payouts
        this.prisma.payout.aggregate({
          where: { instructorId: profile.id, status: 'paid' },
          _sum: { amount: true },
          _count: true,
        }),
        // Last 10 payouts
        this.prisma.payout.findMany({
          where: { instructorId: profile.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

    const grossRevenue = Number(profile.totalRevenue);
    const alreadyPaid  = Number(completedPayouts._sum.amount ?? 0);
    const inProgress   = Number(pendingPayouts._sum.amount  ?? 0);
    const available    = Math.max(0, grossRevenue - alreadyPaid - inProgress);

    return {
      grossRevenue,
      availableBalance: available,
      pendingPayouts:   inProgress,
      paidOut:          alreadyPaid,
      stripeConnected:  !!profile.payoutAccountId,
      recentPayouts,
    };
  }

  // ── Instructor: create Stripe Connect onboarding link ────────────────────

  async createConnectOnboardingLink(instructorId: string) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorId },
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');

    let accountId = profile.payoutAccountId;

    if (!accountId) {
      // Create a new Express account (simplest Connect type)
      const account = await this.stripe.accounts.create({
        type: 'express',
        email: (profile.user as any).email,
        capabilities: { transfers: { requested: true } },
        metadata: { instructorId, userId: instructorId },
      });
      accountId = account.id;

      await this.prisma.instructorProfile.update({
        where: { userId: instructorId },
        data: { payoutAccountId: accountId },
      });
    }

    const frontendUrl = this.configService.get<string>('frontendUrl') ?? 'http://localhost:3000';
    const link = await this.stripe.accountLinks.create({
      account:     accountId,
      refresh_url: `${frontendUrl}/instructor/payouts/connect/refresh`,
      return_url:  `${frontendUrl}/instructor/payouts/connect/success`,
      type:        'account_onboarding',
    });

    return { onboardingUrl: link.url };
  }

  // ── Instructor: request a payout ──────────────────────────────────────────

  async requestPayout(instructorId: string, dto: RequestPayoutDto) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorId },
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');
    if (!profile.payoutAccountId) {
      throw new BadRequestException('Please connect your Stripe account before requesting a payout');
    }

    const currency = (dto.currency ?? 'usd').toLowerCase();
    const amountCents = Math.round(dto.amount * 100);

    // Validate available balance
    const alreadyPaid = await this.prisma.payout.aggregate({
      where: { instructorId: profile.id, status: { in: ['pending', 'paid'] } },
      _sum: { amount: true },
    });
    const available = Number(profile.totalRevenue) - Number(alreadyPaid._sum.amount ?? 0);

    if (dto.amount > available) {
      throw new BadRequestException(
        `Insufficient balance. Available: $${available.toFixed(2)}`,
      );
    }

    // Transfer from platform account to connected account
    let stripePayoutId: string | undefined;
    try {
      const transfer = await this.stripe.transfers.create({
        amount:      amountCents,
        currency,
        destination: profile.payoutAccountId,
        metadata:    { instructorId, profileId: profile.id },
      });
      stripePayoutId = transfer.id;
    } catch (err: any) {
      this.logger.error(`Stripe transfer failed: ${err.message}`);
      throw new BadRequestException(`Payout failed: ${err.message}`);
    }

    const payout = await this.prisma.payout.create({
      data: {
        instructorId:  profile.id,
        amount:        dto.amount,
        currency:      currency.toUpperCase(),
        status:        'paid',
        stripePayoutId,
        description:   `Payout of ${currency.toUpperCase()} ${dto.amount.toFixed(2)}`,
        processedAt:   new Date(),
      },
    });

    // Notify instructor
    const user = profile.user as any;
    this.notificationsService.notifyInstructorPayout(
      instructorId,
      dto.amount,
      currency.toUpperCase(),
      'Earnings payout',
      payout.id,
    ).catch(() => {});

    if (user?.email) {
      this.emailService
        .sendPaymentReceipt(user.email, `${user.firstName} ${user.lastName}`, 'EduBridge', dto.amount, currency.toUpperCase(), payout.id)
        .catch(() => {});
    }

    return payout;
  }

  // ── Instructor: payout history ─────────────────────────────────────────────

  async getPayoutHistory(instructorId: string, pagination: PaginationDto) {
    const { page, limit, skip } = pagination;
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorId },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');

    const [payouts, total] = await Promise.all([
      this.prisma.payout.findMany({
        where: { instructorId: profile.id },
        skip, take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payout.count({ where: { instructorId: profile.id } }),
    ]);

    return { payouts, pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) } };
  }

  // ── Admin: list all payouts ────────────────────────────────────────────────

  async adminListPayouts(pagination: PaginationDto) {
    const { page, limit, skip } = pagination;
    const [payouts, total] = await Promise.all([
      this.prisma.payout.findMany({
        skip, take: limit,
        include: {
          instructor: {
            include: {
              user: { select: { id: true, firstName: true, lastName: true, email: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.payout.count(),
    ]);
    return { payouts, pagination: { page, limit, total, pages: Math.ceil(total / (limit ?? 20)) } };
  }
}
