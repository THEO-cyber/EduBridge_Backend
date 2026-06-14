import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../../common/email/email.service';
import {
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

// Minimal Prisma mock
const prismaMock = {
  user: {
    findFirst:  jest.fn(),
    findUnique: jest.fn(),
    create:     jest.fn(),
    update:     jest.fn(),
  },
  userAuth: {
    findUnique: jest.fn(),
    findFirst:  jest.fn(),
    update:     jest.fn(),
  },
  $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
};

const jwtMock = {
  signAsync: jest.fn().mockResolvedValue('signed-token'),
  verify:    jest.fn().mockReturnValue({ sub: 'user-id' }),
};

const configMock = {
  get: jest.fn((key: string) => {
    const vals: Record<string, string> = {
      'frontendUrl':          'http://localhost:3000',
      'jwt.secret':           'test-secret',
      'jwt.expiresIn':        '7d',
      'jwt.refreshSecret':    'test-refresh-secret',
      'jwt.refreshExpiresIn': '30d',
    };
    return vals[key];
  }),
};

const emailMock = {
  sendEmailVerification: jest.fn().mockResolvedValue(undefined),
  sendPasswordReset:     jest.fn().mockResolvedValue(undefined),
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService,  useValue: prismaMock },
        { provide: JwtService,     useValue: jwtMock    },
        { provide: ConfigService,  useValue: configMock  },
        { provide: EmailService,   useValue: emailMock   },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  // ── register ────────────────────────────────────────────────────────────────

  describe('register', () => {
    it('throws ConflictException when email already exists', async () => {
      prismaMock.user.findFirst.mockResolvedValueOnce({ email: 'a@a.com', username: 'taken' });

      await expect(
        service.register({ email: 'a@a.com', username: 'new', firstName: 'A', lastName: 'B', password: 'Test@1234' }),
      ).rejects.toThrow(ConflictException);
    });

    it('creates user and returns tokens on success', async () => {
      prismaMock.user.findFirst.mockResolvedValueOnce(null);
      prismaMock.user.create.mockResolvedValueOnce({
        id: 'uid', email: 'a@a.com', username: 'newuser',
        firstName: 'A', lastName: 'B', role: 'STUDENT',
        isEmailVerified: false, avatar: null, bio: null,
        timezone: 'UTC', language: 'en',
        instructorProfile: null, studentProfile: {},
      });
      prismaMock.userAuth.update.mockResolvedValueOnce({});

      const result = await service.register({
        email: 'a@a.com', username: 'newuser', firstName: 'A', lastName: 'B', password: 'Test@1234',
      });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.email).toBe('a@a.com');
    });
  });

  // ── login ───────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('throws UnauthorizedException for invalid credentials', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        userAuth: { passwordHash: await bcrypt.hash('correct', 10), lockedUntil: null, loginAttempts: 0 },
        isActive: true,
      });

      await expect(
        service.login({ email: 'a@a.com', password: 'wrong' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when account is deactivated', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        userAuth: { passwordHash: 'hash', lockedUntil: null, loginAttempts: 0 },
        isActive: false,
      });

      await expect(
        service.login({ email: 'a@a.com', password: 'any' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when account is locked', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        userAuth: {
          passwordHash: 'hash',
          lockedUntil: new Date(Date.now() + 10 * 60_000),
          loginAttempts: 5,
        },
        isActive: true,
      });

      await expect(
        service.login({ email: 'a@a.com', password: 'Test@1234' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('returns tokens and resets attempts on valid credentials', async () => {
      const hash = await bcrypt.hash('Test@1234', 10);
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'uid', email: 'a@a.com', username: 'u', firstName: 'A', lastName: 'B',
        role: 'STUDENT', isEmailVerified: true, avatar: null, bio: null,
        timezone: 'UTC', language: 'en',
        isActive: true,
        userAuth: { passwordHash: hash, lockedUntil: null, loginAttempts: 0 },
        instructorProfile: null, studentProfile: {},
      });
      prismaMock.userAuth.update.mockResolvedValue({});
      prismaMock.user.update.mockResolvedValue({});

      const result = await service.login({ email: 'a@a.com', password: 'Test@1234' });

      expect(result).toHaveProperty('accessToken');
      expect(prismaMock.userAuth.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ loginAttempts: 0 }) }),
      );
    });
  });

  // ── verifyEmail ─────────────────────────────────────────────────────────────

  describe('verifyEmail', () => {
    it('throws BadRequestException for invalid token', async () => {
      prismaMock.userAuth.findFirst.mockResolvedValueOnce(null);

      await expect(service.verifyEmail('bad-token')).rejects.toThrow(BadRequestException);
    });

    it('marks email verified and clears token hash', async () => {
      prismaMock.userAuth.findFirst.mockResolvedValueOnce({ userId: 'uid', user: {} });
      prismaMock.$transaction.mockResolvedValueOnce([{}, {}]);

      await service.verifyEmail('valid-raw-token');

      expect(prismaMock.$transaction).toHaveBeenCalled();
    });
  });

  // ── refreshToken ────────────────────────────────────────────────────────────

  describe('refreshToken', () => {
    it('throws UnauthorizedException on token mismatch (replay attack)', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'uid', isActive: true,
        userAuth: { refreshToken: null, refreshTokenHash: 'different-hash' },
      });

      await expect(service.refreshToken('some-jwt-token')).rejects.toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException on inactive user', async () => {
      prismaMock.user.findUnique.mockResolvedValueOnce({
        id: 'uid', isActive: false, userAuth: { refreshToken: null, refreshTokenHash: null },
      });

      await expect(service.refreshToken('some-token')).rejects.toThrow(UnauthorizedException);
    });
  });

  // ── logout ──────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('clears both refresh token fields', async () => {
      prismaMock.userAuth.update.mockResolvedValueOnce({});

      await service.logout('uid');

      expect(prismaMock.userAuth.update).toHaveBeenCalledWith({
        where: { userId: 'uid' },
        data:  { refreshToken: null, refreshTokenHash: null },
      });
    });
  });
});
