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

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    this.region = this.configService.get<string>('AWS_REGION') ?? 'us-east-1';
    this.bucket = this.configService.get<string>('AWS_S3_BUCKET') ?? '';
    this.cloudFrontDomain = this.configService.get<string>('AWS_CLOUDFRONT_DOMAIN');

    this.s3 = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId:     this.configService.get<string>('AWS_ACCESS_KEY_ID') ?? '',
        secretAccessKey: this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ?? '',
      },
    });
  }

  async getUserCertificates(userId: string) {
    const certificates = await this.prisma.certificate.findMany({
      where: { userId },
      include: {
        enrollment: { select: { enrolledAt: true, completedAt: true } },
      },
      orderBy: { issuedAt: 'desc' },
    });

    // Build course info in a separate query
    const courseIds = certificates.map((c) => c.courseId);
    const courses = await this.prisma.course.findMany({
      where: { id: { in: courseIds } },
      include: {
        instructor: { select: { firstName: true, lastName: true } },
      },
    });
    const courseMap = Object.fromEntries(courses.map((c) => [c.id, c]));

    return certificates.map((cert) => ({
      ...cert,
      course: courseMap[cert.courseId] ?? null,
    }));
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

    return { ...cert, course };
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
      select: { title: true },
    });

    return {
      valid: true,
      certificateNumber: cert.certificateNumber,
      recipientName: `${cert.user.firstName} ${cert.user.lastName}`,
      courseTitle: course?.title ?? 'Unknown Course',
      issuedAt: cert.issuedAt,
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
        ServerSideEncryption: 'AES256',
      }),
    );

    const pdfUrl = this.cloudFrontDomain
      ? `https://${this.cloudFrontDomain}/${s3Key}`
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

      // Background
      doc.rect(0, 0, W, H).fill('#0f172a');

      // Gold border
      doc.rect(24, 24, W - 48, H - 48).lineWidth(3).stroke('#f59e0b');

      // Inner border
      doc.rect(32, 32, W - 64, H - 64).lineWidth(1).stroke('#f59e0b').fillOpacity(0);

      // Logo / Platform name
      doc
        .fillColor('#f59e0b')
        .font('Helvetica-Bold')
        .fontSize(28)
        .text('EduBridge', 0, 60, { align: 'center' });

      // Title
      doc
        .fillColor('#ffffff')
        .font('Helvetica')
        .fontSize(14)
        .text('CERTIFICATE OF COMPLETION', 0, 100, { align: 'center', characterSpacing: 4 });

      // Divider
      doc
        .moveTo(W / 2 - 120, 128)
        .lineTo(W / 2 + 120, 128)
        .lineWidth(1)
        .stroke('#f59e0b');

      // This certifies
      doc
        .fillColor('#94a3b8')
        .font('Helvetica')
        .fontSize(13)
        .text('This certifies that', 0, 148, { align: 'center' });

      // Recipient name
      doc
        .fillColor('#f8fafc')
        .font('Helvetica-Bold')
        .fontSize(34)
        .text(data.recipientName, 0, 172, { align: 'center' });

      // Has successfully completed
      doc
        .fillColor('#94a3b8')
        .font('Helvetica')
        .fontSize(13)
        .text('has successfully completed the course', 0, 218, { align: 'center' });

      // Course title
      doc
        .fillColor('#f59e0b')
        .font('Helvetica-Bold')
        .fontSize(22)
        .text(data.courseTitle, 60, 244, { align: 'center', width: W - 120 });

      // Instructor
      doc
        .fillColor('#94a3b8')
        .font('Helvetica')
        .fontSize(12)
        .text(`Instructed by ${data.instructorName}`, 0, 296, { align: 'center' });

      // Divider 2
      doc
        .moveTo(W / 2 - 200, 330)
        .lineTo(W / 2 + 200, 330)
        .lineWidth(0.5)
        .stroke('#334155');

      // Certificate number & date
      const dateStr = data.issuedAt.toLocaleDateString('en-US', {
        year: 'numeric', month: 'long', day: 'numeric',
      });

      doc
        .fillColor('#64748b')
        .font('Helvetica')
        .fontSize(10)
        .text(`Certificate No: ${data.certificateNumber}`, 60, 348, { align: 'left' })
        .text(`Issued: ${dateStr}`, W - 260, 348, { align: 'right', width: 200 });

      doc.end();
    });
  }
}
