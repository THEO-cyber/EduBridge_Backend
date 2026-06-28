import { WorkerHost, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';

export const EMAIL_QUEUE = 'email';

export interface SendEmailJob {
  to: string;
  subject: string;
  html: string;
}

@Processor(EMAIL_QUEUE, { concurrency: 5 } as any)
export class EmailQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(EmailQueueProcessor.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    super();
    this.from = this.configService.get<string>('email.from') || 'noreply@edubridge.com';
    const user = this.configService.get<string>('email.user');
    this.enabled = !!user;

    this.transporter = nodemailer.createTransport({
      host:   this.configService.get<string>('email.host') || 'smtp.gmail.com',
      port:   this.configService.get<number>('email.port') || 587,
      secure: (this.configService.get<number>('email.port') || 587) === 465,
      auth: { user, pass: this.configService.get<string>('email.pass') },
    });
  }

  async process(job: any): Promise<void> {
    const { to, subject, html } = job.data as SendEmailJob;
    if (!this.enabled) {
      this.logger.warn(`Email skipped (no credentials) → ${to}: ${subject}`);
      return;
    }

    await this.transporter.sendMail({ from: this.from, to, subject, html });
    this.logger.log(`Email sent → ${to}: ${subject} (attempt ${job.attemptsMade + 1})`);
  }
}
