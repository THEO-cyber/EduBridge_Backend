import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IsBoolean, IsOptional } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateEmailPreferenceDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() marketingEmails?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() courseUpdates?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() sessionReminders?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() paymentReceipts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() newEnrollmentAlerts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() reviewNotifications?: boolean;
}

@Injectable()
export class EmailPreferencesService {
  private readonly logger = new Logger(EmailPreferencesService.name);
  private get db() { return this.prisma as any; }

  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(userId: string) {
    const pref = await this.db.emailPreference.findUnique({ where: { userId } });
    if (pref) return pref;
    return this.db.emailPreference.create({ data: { userId } });
  }

  async update(userId: string, dto: UpdateEmailPreferenceDto) {
    await this.getOrCreate(userId);

    return this.db.emailPreference.update({
      where: { userId },
      data: {
        ...(dto.marketingEmails     !== undefined && { marketingEmails: dto.marketingEmails }),
        ...(dto.courseUpdates       !== undefined && { courseUpdates: dto.courseUpdates }),
        ...(dto.sessionReminders    !== undefined && { sessionReminders: dto.sessionReminders }),
        ...(dto.paymentReceipts     !== undefined && { paymentReceipts: dto.paymentReceipts }),
        ...(dto.newEnrollmentAlerts !== undefined && { newEnrollmentAlerts: dto.newEnrollmentAlerts }),
        ...(dto.reviewNotifications !== undefined && { reviewNotifications: dto.reviewNotifications }),
      },
    });
  }

  async unsubscribeAll(token: string) {
    const pref = await this.db.emailPreference.findUnique({ where: { unsubscribeToken: token } });
    if (!pref) throw new NotFoundException('Invalid unsubscribe link');

    await this.db.emailPreference.update({
      where: { unsubscribeToken: token },
      data: {
        marketingEmails:     false,
        courseUpdates:       false,
        sessionReminders:    false,
        newEnrollmentAlerts: false,
        reviewNotifications: false,
      },
    });

    this.logger.log(`User ${pref.userId} unsubscribed from all emails`);
    return { message: 'Successfully unsubscribed from all marketing emails' };
  }

  async checkPreference(userId: string, type: keyof UpdateEmailPreferenceDto): Promise<boolean> {
    const pref = await this.db.emailPreference.findUnique({ where: { userId } });
    if (!pref) return true; // default: send emails
    return pref[type] !== false;
  }
}
