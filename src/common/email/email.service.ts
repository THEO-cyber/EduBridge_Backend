import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { EMAIL_QUEUE, SendEmailJob } from './email.queue.processor';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter;
  private readonly from: string;
  private readonly useQueue: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Optional() @InjectQueue(EMAIL_QUEUE) private readonly emailQueue?: any,
  ) {
    this.from = this.configService.get<string>('email.from') || 'noreply@edubridge.com';
    this.useQueue = !!emailQueue && process.env.REDIS_AVAILABLE === 'true';

    this.transporter = nodemailer.createTransport({
      host:   this.configService.get<string>('email.host') || 'smtp.gmail.com',
      port:   this.configService.get<number>('email.port') || 587,
      secure: (this.configService.get<number>('email.port') || 587) === 465,
      auth: {
        user: this.configService.get<string>('email.user'),
        pass: this.configService.get<string>('email.pass'),
      },
    });
  }

  // ─── Core send ────────────────────────────────────────────────────────────
  // When Redis is available: enqueue the job (BullMQ handles 3 retries with
  // exponential backoff, persistent across restarts, visible in Bull Board).
  // When Redis is unavailable: fire-and-forget with in-process retry.

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.configService.get<string>('email.user')) {
      this.logger.warn(`Email skipped (no credentials) → ${to}: ${subject}`);
      return;
    }

    if (this.useQueue && this.emailQueue) {
      await this.emailQueue.add(
        'send-email',
        { to, subject, html },
        { attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 50, removeOnFail: 20 },
      );
      this.logger.debug(`Email queued → ${to}: ${subject}`);
      return;
    }

    // Fallback: direct send with in-process retry
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await this.transporter.sendMail({ from: this.from, to, subject, html });
        this.logger.log(`Email sent (direct) → ${to}: ${subject}`);
        return;
      } catch (error: any) {
        if (attempt < MAX_ATTEMPTS) {
          const delay = 1000 * 2 ** (attempt - 1);
          this.logger.warn(`Email attempt ${attempt} failed (retry in ${delay}ms) → ${to}: ${error.message}`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          this.logger.error(`Email permanently failed → ${to}: ${error.message}`);
        }
      }
    }
  }

  // Dispatch email without blocking the caller's request cycle
  dispatch(to: string, subject: string, html: string): void {
    void this.send(to, subject, html);
  }

  // ─── Verification & Password ───────────────────────────────────────────────

  async sendEmailVerification(to: string, name: string, token: string, frontendUrl: string) {
    const link = `${frontendUrl}/verify-email?token=${token}`;
    await this.send(to, 'Verify your EduBridge account', `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Welcome to EduBridge, ${name}!</h2>
        <p>Click the button below to verify your email address.</p>
        <a href="${link}" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Verify Email
        </a>
        <p style="color:#6b7280;font-size:14px;margin-top:24px">
          Link expires in 24 hours. If you did not create this account, ignore this email.
        </p>
      </div>
    `);
  }

  async sendPasswordResetCode(to: string, name: string, code: string) {
    await this.send(to, 'Your EduBridge password reset code', `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
        <h2 style="color:#1f2937">Password Reset Code</h2>
        <p style="color:#374151">Hi ${name}, use the code below to reset your password.</p>
        <div style="background:#f3f4f6;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
          <p style="margin:0;font-size:14px;color:#6b7280;letter-spacing:0.05em">YOUR RESET CODE</p>
          <p style="margin:8px 0 0;font-size:48px;font-weight:700;letter-spacing:0.3em;color:#4f46e5">${code}</p>
        </div>
        <p style="color:#6b7280;font-size:14px">
          This code expires in <strong>10 minutes</strong>.<br>
          If you did not request a password reset, please ignore this email.
        </p>
      </div>
    `);
  }

  // ─── Enrollment ────────────────────────────────────────────────────────────

  async sendEnrollmentConfirmation(
    to: string,
    studentName: string,
    courseTitle: string,
    instructorName: string,
    frontendUrl: string,
  ) {
    await this.send(to, `You're enrolled in "${courseTitle}"`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Enrollment Confirmed!</h2>
        <p>Hi ${studentName}, you are now enrolled in <strong>${courseTitle}</strong>
           by ${instructorName}.</p>
        <a href="${frontendUrl}/my-courses" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Go to My Courses
        </a>
      </div>
    `);
  }

  async sendCourseCompletionCertificate(
    to: string,
    studentName: string,
    courseTitle: string,
    certificateNumber: string,
    frontendUrl: string,
  ) {
    await this.send(to, `Certificate: ${courseTitle}`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Congratulations, ${studentName}!</h2>
        <p>You have successfully completed <strong>${courseTitle}</strong>.</p>
        <p>Your certificate number: <strong>${certificateNumber}</strong></p>
        <a href="${frontendUrl}/certificates" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          View Certificate
        </a>
      </div>
    `);
  }

  // ─── Live Sessions ─────────────────────────────────────────────────────────

  async sendSessionRequestedToInstructor(
    to: string,
    instructorName: string,
    studentName: string,
    sessionTitle: string,
    preferredDate: Date,
    frontendUrl: string,
  ) {
    await this.send(to, `New session request: "${sessionTitle}"`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>New Session Request</h2>
        <p>Hi ${instructorName}, <strong>${studentName}</strong> has requested a live session:
           <strong>${sessionTitle}</strong> on
           ${preferredDate.toLocaleDateString('en-US', { dateStyle: 'full' })} at
           ${preferredDate.toLocaleTimeString('en-US', { timeStyle: 'short' })}.
        </p>
        <a href="${frontendUrl}/sessions/requests" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Review Request
        </a>
      </div>
    `);
  }

  async sendSessionConfirmedToStudent(
    to: string,
    studentName: string,
    sessionTitle: string,
    instructorName: string,
    scheduledAt: Date,
    frontendUrl: string,
  ) {
    await this.send(to, `Session confirmed: "${sessionTitle}"`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Session Confirmed!</h2>
        <p>Hi ${studentName}, your session <strong>${sessionTitle}</strong> with
           <strong>${instructorName}</strong> has been confirmed for
           ${scheduledAt.toLocaleDateString('en-US', { dateStyle: 'full' })} at
           ${scheduledAt.toLocaleTimeString('en-US', { timeStyle: 'short' })}.
        </p>
        <a href="${frontendUrl}/sessions" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          View Session
        </a>
      </div>
    `);
  }

  async sendSessionReminder(
    to: string,
    name: string,
    sessionTitle: string,
    minutesUntil: number,
    sessionId: string,
    frontendUrl: string,
  ) {
    await this.send(to, `Reminder: "${sessionTitle}" starts in ${minutesUntil} minutes`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Session Starting Soon</h2>
        <p>Hi ${name}, your session <strong>${sessionTitle}</strong> starts in
           <strong>${minutesUntil} minutes</strong>.</p>
        <a href="${frontendUrl}/sessions/${sessionId}/join" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Join Session
        </a>
      </div>
    `);
  }

  // ─── Payments ─────────────────────────────────────────────────────────────

  async sendPaymentReceipt(
    to: string,
    name: string,
    courseTitle: string,
    amount: number,
    currency: string,
    paymentId: string,
  ) {
    await this.send(to, `Receipt: ${courseTitle}`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Payment Receipt</h2>
        <p>Hi ${name}, your payment has been processed.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">Course</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${courseTitle}</strong></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">Amount</td>
              <td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${currency.toUpperCase()} ${amount.toFixed(2)}</strong></td></tr>
          <tr><td style="padding:8px">Payment ID</td>
              <td style="padding:8px">${paymentId}</td></tr>
        </table>
      </div>
    `);
  }

  // ─── Instructor ────────────────────────────────────────────────────────────

  async sendCourseApproved(
    to: string,
    instructorName: string,
    courseTitle: string,
    frontendUrl: string,
  ) {
    await this.send(to, `Your course is live: "${courseTitle}"`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Course Approved!</h2>
        <p>Hi ${instructorName}, your course <strong>${courseTitle}</strong> has been
           approved and is now live on EduBridge.</p>
        <a href="${frontendUrl}/courses" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          View Course
        </a>
      </div>
    `);
  }

  async sendCourseRejected(
    to: string,
    instructorName: string,
    courseTitle: string,
    reason: string,
    frontendUrl: string,
  ) {
    await this.send(to, `Course update: "${courseTitle}"`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <h2>Course Review Feedback</h2>
        <p>Hi ${instructorName}, your course <strong>${courseTitle}</strong> requires
           revisions before it can be published.</p>
        <p><strong>Feedback:</strong> ${reason}</p>
        <a href="${frontendUrl}/instructor/courses" style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Edit Course
        </a>
      </div>
    `);
  }

  async sendInstructorSuspended(
    to: string,
    instructorName: string,
    reason: string,
  ) {
    await this.send(to, 'Your EduBridge instructor account has been suspended', `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
        <h2 style="color:#dc2626">Account Suspended</h2>
        <p>Hi ${instructorName},</p>
        <p>Your instructor account on EduBridge has been suspended by an administrator.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>If you believe this was a mistake, please contact our support team.</p>
      </div>
    `);
  }

  async sendInstructorWarning(
    to: string,
    instructorName: string,
    message: string,
  ) {
    await this.send(to, 'Important notice regarding your EduBridge account', `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
        <h2 style="color:#d97706">Account Warning</h2>
        <p>Hi ${instructorName},</p>
        <p>You have received a formal warning from the EduBridge administration team.</p>
        <p><strong>Message:</strong> ${message}</p>
        <p>Please review our community guidelines. Continued violations may result in account suspension.</p>
      </div>
    `);
  }

  async sendVideoApproved(
    to: string,
    instructorName: string,
    lessonTitle: string,
    frontendUrl: string,
  ) {
    await this.send(to, `Your video "${lessonTitle}" has been approved`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
        <h2 style="color:#16a34a">Video Approved!</h2>
        <p>Hi ${instructorName},</p>
        <p>Great news! Your video for lesson <strong>"${lessonTitle}"</strong> has been reviewed and approved by our team.</p>
        <p>It is now live and visible to your enrolled students.</p>
        <a href="${frontendUrl}/instructor/courses"
           style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          View Your Courses
        </a>
      </div>
    `);
  }

  async sendVideoRejected(
    to: string,
    instructorName: string,
    lessonTitle: string,
    reason: string,
    frontendUrl: string,
  ) {
    await this.send(to, `Action required: video "${lessonTitle}" was not approved`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
        <h2 style="color:#dc2626">Video Not Approved</h2>
        <p>Hi ${instructorName},</p>
        <p>Your video for lesson <strong>"${lessonTitle}"</strong> could not be approved at this time.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p>Please upload a revised video that addresses the feedback above.</p>
        <a href="${frontendUrl}/instructor/courses"
           style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Go to My Courses
        </a>
      </div>
    `);
  }

  async sendSessionReviewPrompt(
    to: string,
    studentName: string,
    sessionTitle: string,
    courseId: string,
    frontendUrl: string,
  ) {
    await this.send(to, `How was "${sessionTitle}"? Leave a review`, `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px">
        <h2>Thanks for attending!</h2>
        <p>Hi ${studentName}, we hope you enjoyed <strong>${sessionTitle}</strong>.</p>
        <p>Your feedback helps other students and motivates instructors. It only takes a moment!</p>
        <a href="${frontendUrl}/courses/${courseId}#reviews"
           style="display:inline-block;padding:12px 24px;background:#4f46e5;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">
          Leave a Review
        </a>
      </div>
    `);
  }
}
