import { Injectable, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  S3Client, PutObjectCommand, GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import PDFDocument = require('pdfkit');

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);
  private s3: S3Client;
  private readonly bucket: string;
  private readonly region: string;
  private readonly cloudFrontDomain?: string;
  private readonly endpoint?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.region = this.configService.get<string>('AWS_REGION') ?? 'us-east-1';
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET') ?? '';
    this.cloudFrontDomain = this.configService.get<string>('AWS_CLOUDFRONT_DOMAIN');
    // S3-compatible endpoint (Cloudflare R2 / MinIO). Without this, region "auto"
    // (R2) resolves to the invalid host <bucket>.s3.auto.amazonaws.com.
    this.endpoint = this.configService.get<string>('S3_ENDPOINT');

    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId:     this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? '',
        secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? '',
      },
      ...(this.endpoint ? { endpoint: this.endpoint, forcePathStyle: true } : {}),
    });
  }

  async getUserCertificates(userId: string) {
    const certificates = await this.prisma.certificate.findMany({
      where: { userId },
      include: {
        user:       { select: { firstName: true, lastName: true } },
        enrollment: { select: { enrolledAt: true, completedAt: true } },
      },
      orderBy: { issuedAt: 'desc' },
    });

    const courseIds = certificates.map((c) => c.courseId);
    const courses = await this.prisma.course.findMany({
      where: { id: { in: courseIds } },
      include: {
        instructor: { select: { firstName: true, lastName: true } },
      },
    });
    const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));

    return certificates.map((cert) => {
      const course = courseMap[cert.courseId] ?? null;
      return {
        ...cert,
        // Flat fields Flutter can use directly for the certificate card/screen
        recipientName:  `${cert.user.firstName} ${cert.user.lastName}`,
        courseTitle:    course?.title ?? 'Unknown Course',
        instructorName: course?.instructor
          ? `${course.instructor.firstName} ${course.instructor.lastName}`
          : 'EduBridge',
        issuedBy:       'EduBridge Academy',
        signature:      'EduBridge Academy',
        course,
      };
    });
  }

  async getCertificate(certificateId: string, userId: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      include: {
        user:       { select: { firstName: true, lastName: true, email: true } },
        enrollment: { select: { enrolledAt: true, completedAt: true } },
      },
    });

    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.userId !== userId) throw new ForbiddenException();

    const course = await this.prisma.course.findUnique({
      where: { id: cert.courseId },
      include: {
        instructor: { select: { firstName: true, lastName: true } },
      },
    });

    const recipientName  = `${cert.user.firstName} ${cert.user.lastName}`;
    const courseTitle    = course?.title ?? 'Unknown Course';
    const instructorName = course?.instructor
      ? `${course.instructor.firstName} ${course.instructor.lastName}`
      : 'EduBridge';

    return {
      ...cert,
      // Flat fields Flutter can use directly to render the certificate screen
      recipientName,
      courseTitle,
      instructorName,
      issuedBy:  'EduBridge Academy',
      signature: 'EduBridge Academy',
      course,
    };
  }

  async getCertificateByNumber(certNumber: string) {
    const cert = await this.prisma.certificate.findUnique({
      where: { certificateNumber: certNumber },
      include: {
        user: { select: { firstName: true, lastName: true } },
      },
    });
    if (!cert) throw new NotFoundException('Certificate not found');

    const course = await this.prisma.course.findUnique({
      where: { id: cert.courseId },
      include: { instructor: { select: { firstName: true, lastName: true } } },
    });

    return {
      valid:             true,
      certificateNumber: cert.certificateNumber,
      recipientName:     `${cert.user.firstName} ${cert.user.lastName}`,
      courseTitle:       course?.title ?? 'Unknown Course',
      instructorName:    course?.instructor
        ? `${course.instructor.firstName} ${course.instructor.lastName}`
        : 'EduBridge',
      issuedBy:          'EduBridge Academy',
      signature:         'EduBridge Academy',
      issuedAt:          cert.issuedAt,
    };
  }

  async generateAndStorePdf(certificateId: string, userId: string): Promise<string> {
    const cert = await this.prisma.certificate.findUnique({
      where: { id: certificateId },
      include: { user: true },
    });
    if (!cert) throw new NotFoundException('Certificate not found');
    if (cert.userId !== userId) throw new ForbiddenException();

    // Return cached PDF if already generated
    if (cert.pdfUrl) return cert.pdfUrl;

    const course = await this.prisma.course.findUnique({
      where: { id: cert.courseId },
      include: { instructor: { select: { firstName: true, lastName: true } } },
    });

    const pdfBuffer = await this.buildPdf({
      recipientName:    `${cert.user.firstName} ${cert.user.lastName}`,
      courseTitle:      course?.title ?? 'Course',
      instructorName:   course?.instructor
        ? `${course.instructor.firstName} ${course.instructor.lastName}`
        : 'EduBridge',
      certificateNumber: cert.certificateNumber,
      issuedAt:          cert.issuedAt,
    });

    const s3Key = `certificates/${userId}/${cert.certificateNumber}.pdf`;

    await this.s3.send(
      new PutObjectCommand({
        Bucket:             this.bucket,
        Key:                s3Key,
        Body:               pdfBuffer,
        ContentType:        'application/pdf',
        ContentDisposition: `attachment; filename="${cert.certificateNumber}.pdf"`,
      }),
    );

    const publicBase =
      this.configService.get<string>('S3_PUBLIC_URL') || this.endpoint;
    const pdfUrl = this.cloudFrontDomain
      ? `https://${this.cloudFrontDomain}/${s3Key}`
      : publicBase
        ? `${publicBase.replace(/\/+$/, '')}/${this.bucket}/${s3Key}`
        : `https://${this.bucket}.s3.${this.region}.amazonaws.com/${s3Key}`;

    await this.prisma.certificate.update({ where: { id: certificateId }, data: { pdfUrl } });

    this.logger.log(`PDF generated for certificate ${cert.certificateNumber}`);
    return pdfUrl;
  }

  async getDownloadUrl(certificateId: string, userId: string): Promise<string> {
    const pdfUrl = await this.generateAndStorePdf(certificateId, userId);

    if (this.cloudFrontDomain) return pdfUrl; // CloudFront serves directly

    const cert = await this.prisma.certificate.findUnique({ where: { id: certificateId } });
    const s3Key = `certificates/${userId}/${cert!.certificateNumber}.pdf`;

    return getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
      { expiresIn: 3600 },
    );
  }

  // ─── PDF builder ───────────────────────────────────────────────────────────

  private buildPdf(data: {
    recipientName: string;
    courseTitle: string;
    instructorName: string;
    certificateNumber: string;
    issuedAt: Date;
  }): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        layout: 'landscape',
        margin: 0,
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = doc.page.width;
      const H = doc.page.height;

      // ── Palette (kept in sync with the mobile app + web CertificateCard) ────
      const GOLD = '#F59E0B';
      const GOLD_LT = '#FBBF24';
      const NAVY = '#0F172A';
      const SLATE = '#1E293B';
      const GREY = '#607D8B';
      const CREAM = '#F8FAFC';

      const issuedBy = 'EduBridge Academy';
      const instructor = data.instructorName?.trim() || 'Course Instructor';
      const dateStr = data.issuedAt.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric',
      });

      // Five-point star (Times has no ★ glyph, so draw it).
      const star = (cx: number, cy: number, r: number, color: string) => {
        doc.save();
        for (let i = 0; i < 10; i++) {
          const a = (Math.PI / 5) * i - Math.PI / 2;
          const rr = i % 2 === 0 ? r : r * 0.5;
          const px = cx + Math.cos(a) * rr;
          const py = cy + Math.sin(a) * rr;
          if (i === 0) doc.moveTo(px, py);
          else doc.lineTo(px, py);
        }
        doc.closePath().fill(color);
        doc.restore();
      };

      // ── Cream background ────────────────────────────────────────────────────
      doc.rect(0, 0, W, H).fill(CREAM);

      // ── Faint rotated wordmark watermark ────────────────────────────────────
      doc.save();
      doc.rotate(-28, { origin: [W / 2, H / 2] });
      doc
        .fillColor(NAVY)
        .fillOpacity(0.04)
        .font('Times-Bold')
        .fontSize(100)
        .text('EDUBRIDGE', 0, H / 2 - 62, { width: W, align: 'center' });
      doc.restore();
      doc.fillOpacity(1);

      // ── Gold double border ──────────────────────────────────────────────────
      doc.rect(12, 12, W - 24, H - 24).lineWidth(2.5).stroke(GOLD);
      doc.save().strokeOpacity(0.4);
      doc.rect(18, 18, W - 36, H - 36).lineWidth(1).stroke(GOLD);
      doc.restore();

      // ── Corner ornaments ────────────────────────────────────────────────────
      const corner = (x: number, y: number, sx: number, sy: number) => {
        doc.save().strokeColor(GOLD).lineWidth(1.5);
        doc.moveTo(x, y).lineTo(x + 22 * sx, y);
        doc.moveTo(x, y).lineTo(x, y + 22 * sy);
        doc.stroke();
        doc.moveTo(x + 4 * sx, y + 4 * sy).lineTo(x + 13 * sx, y + 4 * sy);
        doc.moveTo(x + 4 * sx, y + 4 * sy).lineTo(x + 4 * sx, y + 13 * sy);
        doc.stroke();
        doc.circle(x, y, 2).fill(GOLD);
        doc.restore();
      };
      corner(26, 26, 1, 1);
      corner(W - 26, 26, -1, 1);
      corner(26, H - 26, 1, -1);
      corner(W - 26, H - 26, -1, -1);

      // ── Header: navy "E" roundel + wordmark ─────────────────────────────────
      doc.font('Times-Bold').fontSize(14);
      const brandW = doc.widthOfString('EDUBRIDGE', { characterSpacing: 4 });
      const groupX = (W - (28 + 10 + brandW)) / 2;
      doc.circle(groupX + 14, 44, 14).fill(NAVY);
      doc
        .fillColor(GOLD)
        .font('Times-Bold')
        .fontSize(16)
        .text('E', groupX, 37, { width: 28, align: 'center' });
      doc
        .fillColor(NAVY)
        .font('Times-Bold')
        .fontSize(14)
        .text('EDUBRIDGE', groupX + 38, 38, { characterSpacing: 4, lineBreak: false });

      // ── Gold divider (line ★ line) ──────────────────────────────────────────
      const dy = 74;
      doc.save().strokeOpacity(0.5).strokeColor(GOLD).lineWidth(1);
      doc.moveTo(W / 2 - 105, dy).lineTo(W / 2 - 12, dy).stroke();
      doc.moveTo(W / 2 + 12, dy).lineTo(W / 2 + 105, dy).stroke();
      doc.restore();
      star(W / 2, dy, 5, GOLD);

      // ── Title ───────────────────────────────────────────────────────────────
      doc
        .fillColor(NAVY)
        .font('Times-Bold')
        .fontSize(28)
        .text('Certificate of Completion', 0, 92, { width: W, align: 'center', characterSpacing: 1 });

      doc
        .fillColor(GREY)
        .font('Times-Roman')
        .fontSize(9)
        .text('THIS IS TO CERTIFY THAT', 0, 132, { width: W, align: 'center', characterSpacing: 3 });

      // ── Recipient ───────────────────────────────────────────────────────────
      doc
        .fillColor(NAVY)
        .font('Times-BoldItalic')
        .fontSize(34)
        .text(data.recipientName, 60, 155, { width: W - 120, align: 'center', characterSpacing: 0.5 });

      doc.save().fillOpacity(0.6);
      doc.rect(W / 2 - 110, 202, 220, 0.75).fill(GOLD);
      doc.restore();

      doc
        .fillColor(GREY)
        .font('Times-Roman')
        .fontSize(9)
        .text('HAS SUCCESSFULLY COMPLETED THE COURSE', 0, 212, {
          width: W, align: 'center', characterSpacing: 2.5,
        });

      // ── Course ──────────────────────────────────────────────────────────────
      doc
        .fillColor(SLATE)
        .font('Times-Bold')
        .fontSize(18)
        .text(`"${data.courseTitle}"`, 60, 234, { width: W - 120, align: 'center', characterSpacing: 0.5 });

      // ── Certificate no. + date ──────────────────────────────────────────────
      doc.fillColor(GREY).font('Times-Roman').fontSize(8);
      const noStr = `Certificate No: #${data.certificateNumber}`;
      const isStr = `Issued: ${dateStr}`;
      const noW = doc.widthOfString(noStr, { characterSpacing: 1 });
      const infoX = (W - (noW + 24 + doc.widthOfString(isStr, { characterSpacing: 1 }))) / 2;
      doc.text(noStr, infoX, 470, { characterSpacing: 1, lineBreak: false });
      doc.text(isStr, infoX + noW + 24, 470, { characterSpacing: 1, lineBreak: false });

      // ── Centre seal ─────────────────────────────────────────────────────────
      const cx = W / 2;
      const cy = 527;
      const grad = doc.radialGradient(cx, cy - 8, 0, cx, cy, 30);
      grad.stop(0, GOLD_LT).stop(0.6, GOLD).stop(1, '#8B6914');
      doc.circle(cx, cy, 30).fill(grad);
      star(cx, cy - 12, 8, NAVY);
      doc
        .fillColor(NAVY)
        .font('Times-Bold')
        .fontSize(5)
        .text('EDUBRIDGE', cx - 30, cy + 2, { width: 60, align: 'center', characterSpacing: 0.8 });
      doc
        .fillColor(NAVY)
        .font('Times-Roman')
        .fontSize(4)
        .text('CERTIFIED', cx - 30, cy + 10, { width: 60, align: 'center', characterSpacing: 0.6 });

      // ── Signatures ──────────────────────────────────────────────────────────
      const sig = (centerX: number, name: string, label: string) => {
        doc.save().strokeColor(NAVY).lineWidth(0.75);
        doc.moveTo(centerX - 60, 518).lineTo(centerX + 60, 518).stroke();
        doc.restore();
        doc
          .fillColor(NAVY)
          .font('Times-Bold')
          .fontSize(9)
          .text(name, centerX - 80, 523, { width: 160, align: 'center', lineBreak: false, ellipsis: true });
        doc
          .fillColor(GREY)
          .font('Times-Roman')
          .fontSize(6.5)
          .text(label, centerX - 80, 536, {
            width: 160, align: 'center', characterSpacing: 1.2, lineBreak: false,
          });
      };
      sig(60 + (W / 2 - 30 - 60) / 2, issuedBy, 'AUTHORIZED SIGNATORY');
      sig(W / 2 + 30 + (W - 60 - (W / 2 + 30)) / 2, instructor, 'COURSE INSTRUCTOR');

      doc.end();
    });
  }
}
