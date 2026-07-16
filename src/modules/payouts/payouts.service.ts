import {
  Injectable, NotFoundException, BadRequestException, Logger,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { NkwaService } from '../../common/nkwa/nkwa.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../../common/email/email.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { IsNumber, IsOptional, IsString, Min, Matches } from 'class-validator';
import { Type } from 'class-transformer';

export class RequestPayoutDto {
  @IsNumber() @Type(() => Number) @Min(500) amount!: number;
  @IsOptional() @IsString() currency?: string;
}

export class ConnectPayoutDto {
  @IsString()
  @Matches(/^(\+?237)?[0-9]{9}$/, { message: 'phoneNumber must be a valid Cameroon MoMo/Orange number' })
  phoneNumber!: string;
}

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly nkwa: NkwaService,
    private readonly notificationsService: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  private get currency(): string {
    return this.configService.get<string>('currency') || 'XAF';
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
      currency:         this.currency,
      payoutConnected:  !!profile.payoutPhone,
      payoutPhone:      profile.payoutPhone,
      recentPayouts,
    };
  }

  // ── Instructor: save MoMo/Orange payout number ────────────────────────────

  async savePayoutPhone(instructorId: string, dto: ConnectPayoutDto) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorId },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');

    await this.prisma.instructorProfile.update({
      where: { userId: instructorId },
      data: { payoutPhone: dto.phoneNumber },
    });

    return { connected: true, payoutPhone: dto.phoneNumber };
  }

  // ── Instructor: request a payout ──────────────────────────────────────────

  async requestPayout(instructorId: string, dto: RequestPayoutDto) {
    const profile = await this.prisma.instructorProfile.findUnique({
      where: { userId: instructorId },
      include: { user: { select: { email: true, firstName: true, lastName: true } } },
    });
    if (!profile) throw new NotFoundException('Instructor profile not found');
    if (!profile.payoutPhone) {
      throw new BadRequestException('Please add your MoMo/Orange Money payout number before requesting a payout');
    }

    const currency = this.currency;
    const amount = Math.round(dto.amount); // XAF is zero-decimal

    // Validate available balance
    const alreadyPaid = await this.prisma.payout.aggregate({
      where: { instructorId: profile.id, status: { in: ['pending', 'paid'] } },
      _sum: { amount: true },
    });
    const available = Number(profile.totalRevenue) - Number(alreadyPaid._sum.amount ?? 0);

    if (amount > available) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${currency} ${Math.floor(available)}`,
      );
    }

    // Disburse to the instructor's MoMo/Orange number via Nkwa.
    let nkwaPayoutId: string | undefined;
    try {
      const disbursement = await this.nkwa.disburse(
        amount,
        profile.payoutPhone,
        'EduBridge earnings payout',
      );
      nkwaPayoutId = disbursement.id;
    } catch (err: any) {
      this.logger.error(`Nkwa disbursement failed: ${err.message}`);
      throw new BadRequestException(`Payout failed: ${err.message}`);
    }

    const payout = await this.prisma.payout.create({
      data: {
        instructorId:  profile.id,
        amount,
        currency,
        status:        'paid',
        stripePayoutId: nkwaPayoutId, // reuse existing column to store the Nkwa disbursement id
        description:   `Payout of ${currency} ${amount}`,
        processedAt:   new Date(),
      },
    });

    // Notify instructor
    const user = profile.user as any;
    this.notificationsService.notifyInstructorPayout(
      instructorId,
      amount,
      currency,
      'Earnings payout',
      payout.id,
    ).catch(() => {});

    if (user?.email) {
      this.emailService
        .sendPaymentReceipt(user.email, `${user.firstName} ${user.lastName}`, 'EduBridge', amount, currency, payout.id)
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
