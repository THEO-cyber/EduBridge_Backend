import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from '../notifications/notifications.service';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PaymentStatus, TransactionType } from '@prisma/client';

const prismaMock = {
  course:    { findUnique: jest.fn(), update: jest.fn() },
  payment:   { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  enrollment: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  coupon:    { findUnique: jest.fn(), update: jest.fn() },
  instructorProfile: { update: jest.fn(), findUnique: jest.fn() },
  userAnalytics: { upsert: jest.fn() },
  $transaction: jest.fn(async (cb: any) => cb({
    payment:          { update: jest.fn(), findUnique: jest.fn() },
    enrollment:       { create: jest.fn(), update: jest.fn() },
    course:           { update: jest.fn() },
    instructorProfile: { update: jest.fn() },
    coupon:           { update: jest.fn() },
    userAnalytics:    { upsert: jest.fn() },
  })),
};

const configMock = {
  get: jest.fn((key: string) => {
    const vals: Record<string, string> = {
      'stripe.secretKey':     'sk_test_placeholder',
      'stripe.webhookSecret': 'whsec_placeholder',
    };
    return vals[key] ?? '';
  }),
};

const notifMock = {
  notifyPaymentSuccess:   jest.fn().mockResolvedValue(undefined),
  notifyEnrollmentSuccess: jest.fn().mockResolvedValue(undefined),
  notifyRefundProcessed:  jest.fn().mockResolvedValue(undefined),
};

describe('PaymentsService', () => {
  let service: PaymentsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService,        useValue: prismaMock  },
        { provide: ConfigService,        useValue: configMock  },
        { provide: NotificationsService, useValue: notifMock   },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
  });

  // ── enrollFree ─────────────────────────────────────────────────────────────

  describe('enrollFree', () => {
    it('throws BadRequestException if course is not free', async () => {
      prismaMock.course.findUnique.mockResolvedValueOnce({ id: 'c1', price: 29.99, isPublished: true, status: 'PUBLISHED' });

      await expect(service.enrollFree('user-1', 'c1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if already enrolled', async () => {
      prismaMock.course.findUnique.mockResolvedValueOnce({ id: 'c1', price: 0, isPublished: true, status: 'PUBLISHED' });
      prismaMock.enrollment.findUnique.mockResolvedValueOnce({ id: 'e1' });

      await expect(service.enrollFree('user-1', 'c1')).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException if course does not exist', async () => {
      prismaMock.course.findUnique.mockResolvedValueOnce(null);

      await expect(service.enrollFree('user-1', 'missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ── getPaymentHistory ──────────────────────────────────────────────────────

  describe('getPaymentHistory', () => {
    it('returns paginated payment history for user', async () => {
      const fakePay = { id: 'p1', amount: 99, status: PaymentStatus.COMPLETED };
      prismaMock.payment.findMany.mockResolvedValueOnce([fakePay]);
      prismaMock.payment.count.mockResolvedValueOnce(1);

      const result = await service.getPaymentHistory('user-1', 1, 10);

      expect(result.payments).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(prismaMock.payment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1' }, take: 10, skip: 0 }),
      );
    });
  });

  // ── getInvoice ─────────────────────────────────────────────────────────────

  describe('getInvoice', () => {
    it('throws NotFoundException when payment does not exist', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce(null);

      await expect(service.getInvoice('user-1', 'missing-id')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when payment belongs to different user', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce({
        id: 'p1', userId: 'other-user',
        user: { firstName: 'Other', lastName: 'User', email: 'other@test.com' },
        amount: 99, currency: 'USD', status: PaymentStatus.COMPLETED,
        type: TransactionType.COURSE_PURCHASE,
        description: 'Course purchase', metadata: null,
        stripePaymentIntentId: null, createdAt: new Date(),
      });

      await expect(service.getInvoice('user-1', 'p1')).rejects.toThrow(ForbiddenException);
    });

    it('returns invoice object for valid payment', async () => {
      prismaMock.payment.findUnique.mockResolvedValueOnce({
        id: 'p1', userId: 'user-1',
        user: { firstName: 'John', lastName: 'Doe', email: 'john@test.com' },
        amount: 49.99, currency: 'USD', status: PaymentStatus.COMPLETED,
        type: TransactionType.COURSE_PURCHASE,
        description: null, metadata: null,
        stripePaymentIntentId: 'pi_123', createdAt: new Date(),
      });

      const invoice = await service.getInvoice('user-1', 'p1');

      expect(invoice).toHaveProperty('invoiceNumber');
      expect(invoice.customer.email).toBe('john@test.com');
      expect(invoice.total).toBe(49.99);
    });
  });
});
